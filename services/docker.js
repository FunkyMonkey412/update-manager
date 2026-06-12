const { dbRun } = require('../db');
const { connectToServer, makeSudoExec } = require('./ssh');
const { logUpdate } = require('./update');
const { notifyUpdate } = require('./notifications');

function validatePath(p) {
    if (/[;|`$()]/.test(p)) throw new Error('Invalid path: contains forbidden characters');
    if (!p.startsWith('/')) throw new Error('Path must be absolute');
}

async function detectDockerComposeCommand(ssh, sudoExec) {
    const v2 = await sudoExec('docker compose version');
    if (v2.code === 0) return 'docker compose';
    const v1 = await sudoExec('docker-compose --version');
    if (v1.code === 0) return 'docker-compose';
    throw new Error('Neither docker compose nor docker-compose found on this host');
}

async function connectToDockerHost(dockerHost) {
    const ssh = await connectToServer(dockerHost);
    const sudoExec = makeSudoExec(ssh, dockerHost.sudo_password_hash);

    let composeCommand = dockerHost.docker_compose_command;
    if (!composeCommand) {
        composeCommand = await detectDockerComposeCommand(ssh, sudoExec);
        await dbRun('UPDATE docker_hosts SET docker_compose_command = ? WHERE id = ?',
            [composeCommand, dockerHost.id]);
    }

    return { ssh, sudoExec, composeCommand };
}

async function updateDockerComposeProject(project, progressCallback = null, updateType = 'manual') {
    const details = { pullOutput: '', upOutput: '', imagesUpdated: [], containersRecreated: [] };
    const emit = (stage, message) => progressCallback?.({ stage, message });

    try {
        validatePath(project.compose_file_path);
        validatePath(project.working_directory);

        emit('connecting', `Connecting to ${project.host_name || 'host'}...`);
        const { ssh, sudoExec, composeCommand } = await connectToDockerHost(project);

        await dbRun('UPDATE docker_compose_projects SET status = ? WHERE id = ?', ['updating', project.id]);

        const cd = `cd ${project.working_directory}`;
        const composeFile = `-f ${project.compose_file_path}`;

        // Step 1: pull
        emit('pulling', 'Pulling latest Docker images...');
        const pullResult = await sudoExec(`sh -c '${cd} && ${composeCommand} ${composeFile} pull'`, {
            onStdout: chunk => {
                const out = chunk.toString();
                details.pullOutput += out;
                emit('pulling', out.trim().slice(-120));
            },
            onStderr: chunk => { details.pullOutput += chunk.toString(); }
        });
        if (pullResult.code !== 0) throw new Error(`Docker pull failed: ${pullResult.stderr}`);

        // Step 2: up -d
        emit('recreating', 'Recreating containers...');
        const upResult = await sudoExec(`sh -c '${cd} && ${composeCommand} ${composeFile} up -d'`, {
            onStdout: chunk => {
                const out = chunk.toString();
                details.upOutput += out;
                emit('recreating', out.trim().slice(-120));
            },
            onStderr: chunk => { details.upOutput += chunk.toString(); }
        });
        if (upResult.code !== 0) throw new Error(`Docker up failed: ${upResult.stderr}`);

        // Parse results
        const pulledRe = /Downloaded newer image for ([\w\/:.@-]+)/g;
        let m;
        while ((m = pulledRe.exec(details.pullOutput)) !== null) details.imagesUpdated.push(m[1]);

        const recreatedRe = /Container ([\w-]+)\s+(Recreated|Created|Started)/g;
        while ((m = recreatedRe.exec(details.upOutput)) !== null) {
            if (!details.containersRecreated.includes(m[1])) details.containersRecreated.push(m[1]);
        }

        const now = new Date().toISOString();
        await dbRun('UPDATE docker_compose_projects SET status = ?, last_update = ? WHERE id = ?',
            ['updated', now, project.id]);
        await dbRun('UPDATE docker_hosts SET last_update = ? WHERE id = ?', [now, project.host_id]);

        ssh.dispose();

        const msg = details.imagesUpdated.length > 0 || details.containersRecreated.length > 0
            ? `Updated ${details.imagesUpdated.length} image(s), ${details.containersRecreated.length} container(s) affected`
            : 'No updates available';

        emit('completed', msg);

        await logUpdate('docker', project.id, project.name, updateType, true, msg,
            JSON.stringify({
                imagesUpdated: details.imagesUpdated,
                containersRecreated: details.containersRecreated,
                pullOutput: details.pullOutput.slice(-2000),
                upOutput: details.upOutput.slice(-2000)
            })
        );
        notifyUpdate({ entity_type: 'docker', entity_name: project.name, update_type: updateType, success: true, message: msg });

        return { success: true, message: msg };

    } catch (error) {
        console.error(`[docker] ${project.name}: ${error.message}`);
        await dbRun('UPDATE docker_compose_projects SET status = ? WHERE id = ?', ['failed', project.id]);
        emit('failed', `Update failed: ${error.message}`);

        await logUpdate('docker', project.id, project.name, updateType, false, error.message,
            JSON.stringify({ error: error.message, ...details })
        );
        notifyUpdate({ entity_type: 'docker', entity_name: project.name, update_type: updateType, success: false, message: error.message });

        return { success: false, message: error.message };
    }
}

async function updateDockerHost(hostId, updateType = 'manual', progressCallback = null) {
    const { dbAll } = require('../db');
    const emit = (stage, message) => progressCallback?.({ stage, message });

    const projects = await dbAll(`
        SELECT p.*, h.name as host_name, h.ip_address, h.port, h.username,
               h.auth_type, h.password_hash, h.ssh_key_path, h.sudo_password_hash,
               h.docker_compose_command, h.credential_id
        FROM docker_compose_projects p
        JOIN docker_hosts h ON p.host_id = h.id
        WHERE h.id = ?
    `, [hostId]);

    const results = [];
    for (let i = 0; i < projects.length; i++) {
        const project = projects[i];
        emit('project_start', JSON.stringify({ name: project.name, current: i + 1, total: projects.length }));

        const result = await updateDockerComposeProject(project, (progress) => {
            emit('project_progress', JSON.stringify({ project: project.name, ...progress }));
        }, updateType);

        results.push({ project: project.name, ...result });
    }

    return { host_id: hostId, results };
}

async function updateDockerGroup(groupId, updateType = 'manual', progressCallback = null) {
    const { dbAll } = require('../db');
    const emit = (stage, message) => progressCallback?.({ stage, message });

    const hosts = await dbAll('SELECT * FROM docker_hosts WHERE group_id = ?', [groupId]);
    const results = [];

    for (const host of hosts) {
        emit('host_start', JSON.stringify({ name: host.name }));
        try {
            const hostResult = await updateDockerHost(host.id, updateType, (progress) => {
                emit('host_progress', JSON.stringify({ host: host.name, ...progress }));
            });
            results.push(...hostResult.results);
        } catch (error) {
            results.push({ host: host.name, success: false, message: error.message });
        }
    }

    return { group_id: groupId, results };
}

module.exports = { updateDockerComposeProject, updateDockerHost, updateDockerGroup, validatePath, connectToDockerHost };
