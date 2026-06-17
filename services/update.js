const { dbRun, dbGet } = require('../db');
const { connectToServer, makeSudoExec } = require('./ssh');
const { decrypt } = require('../utils/crypto');
const { notifyUpdate } = require('./notifications');
const http  = require('http');
const https = require('https');

async function logUpdate(entity_type, entity_id, entity_name, update_type, success, message, details = null) {
    try {
        await dbRun(
            `INSERT INTO update_logs (entity_type, entity_id, entity_name, update_type, success, message, details)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [entity_type, entity_id, entity_name, update_type, success ? 1 : 0, message, details]
        );
    } catch (err) {
        console.error('[update] Failed to log update:', err.message);
    }
}

async function updateServerTrueNAS(server, progressCallback = null, updateType = 'manual') {
    const emit = (stage, message) => progressCallback?.({ stage, message });

    // Resolve password for HTTP Basic auth
    let username, password;
    if (server.credential_id) {
        const cred = await dbGet('SELECT * FROM credentials WHERE id = ?', [server.credential_id]);
        if (!cred) throw new Error('Saved credential not found');
        username = cred.username;
        password = cred.password_hash ? decrypt(cred.password_hash) : null;
    } else {
        username = server.username;
        password = server.password_hash ? decrypt(server.password_hash) : null;
    }
    if (!password) throw new Error('A password is required for TrueNAS CE updates');

    const protocol  = server.truenas_protocol || 'https';
    const verifySSL = !!server.truenas_verify_ssl;
    const httpModule = protocol === 'https' ? https : http;
    const agent = protocol === 'https' ? new https.Agent({ rejectUnauthorized: verifySSL }) : undefined;
    const port  = protocol === 'https' ? 443 : 80;

    const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

    const apiRequest = (method, path, body = null) => new Promise((resolve, reject) => {
        const payload = body !== null ? JSON.stringify(body) : null;
        const req = httpModule.request({
            hostname: server.ip_address,
            port,
            path: `/api/v2.0${path}`,
            method,
            ...(agent ? { agent } : {}),
            headers: {
                Authorization: authHeader,
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`TrueNAS API ${res.statusCode}: ${data}`));
                try { resolve(JSON.parse(data)); } catch { resolve(data); }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });

    const apiGet = path => apiRequest('GET', path);
    const apiPost = (path, body = {}) => apiRequest('POST', path, body);
    const pollJob = async (jobId, onProgress) => {
        while (true) {
            await new Promise(r => setTimeout(r, 5000));
            let jobs;
            try { jobs = await apiGet(`/core/get_jobs?id=${jobId}`); } catch { return; }
            const job = jobs?.[0];
            if (!job) return;
            if (job.state === 'SUCCESS') return job;
            if (job.state === 'FAILED' || job.state === 'ABORTED')
                throw new Error(job.error || `Update job ${job.state.toLowerCase()}`);
            onProgress?.(job.progress?.percent ?? 0, job.progress?.description || job.state);
        }
    };

    try {
        emit('connecting', `Connecting to ${server.name}...`);

        // Check what's available
        emit('checking', 'Checking for available updates...');
        const status = await apiGet('/update/status');

        if (!status.status?.new_version) {
            await dbRun('UPDATE servers SET status=?, last_update=? WHERE id=?',
                ['updated', new Date().toISOString(), server.id]);
            const message = 'No updates available';
            emit('completed', message);
            await logUpdate('server', server.id, server.name, updateType, true, message, JSON.stringify({ available: false }));
            notifyUpdate({ entity_type: 'server', entity_name: server.name, update_type: updateType, success: true, message });
            return { success: true, message, needsReboot: false };
        }

        const newVersion = status.status.new_version.version;
        const downloadPct = status.update_download_progress?.percent ?? 0;

        // Download if not already complete
        if (downloadPct < 100) {
            emit('updating', `Downloading update ${newVersion}...`);
            const downloadJobId = await apiPost('/update/download');
            await pollJob(downloadJobId, (pct, desc) =>
                emit('updating', `Downloading ${newVersion}: ${Math.round(pct)}% — ${desc}`)
            );
        } else {
            emit('updating', `Update ${newVersion} already downloaded — applying...`);
        }

        // Apply — triggers reboot, connection will drop
        emit('updating', `Applying update ${newVersion} — system will reboot...`);
        try {
            const runJobId = await apiPost('/update/run', {});
            await pollJob(runJobId, (pct, desc) =>
                emit('updating', `Installing: ${Math.round(pct)}% — ${desc}`)
            );
        } catch {
            // Connection drops when TrueNAS reboots — expected
        }

        await dbRun('UPDATE servers SET status=?, last_update=?, needs_reboot=? WHERE id=?',
            ['updated', new Date().toISOString(), 1, server.id]);

        const message = `TrueNAS CE updated to ${newVersion} — reboot required to activate`;
        emit('completed', message);
        await logUpdate('server', server.id, server.name, updateType, true, message, JSON.stringify({ newVersion }));
        notifyUpdate({ entity_type: 'server', entity_name: server.name, update_type: updateType, success: true, message });
        return { success: true, message, needsReboot: false };

    } catch (error) {
        console.error(`[update] TrueNAS ${server.name}: ${error.message}`);
        await dbRun('UPDATE servers SET status=? WHERE id=?', ['failed', server.id]);
        emit('failed', `Update failed: ${error.message}`);
        await logUpdate('server', server.id, server.name, updateType, false, error.message, JSON.stringify({ error: error.message }));
        notifyUpdate({ entity_type: 'server', entity_name: server.name, update_type: updateType, success: false, message: error.message });
        return { success: false, message: error.message };
    }
}

async function updateServer(server, progressCallback = null, updateType = 'manual') {
    if (server.os_type === 'truenas_ce') return updateServerTrueNAS(server, progressCallback, updateType);

    const details = { updateOutput: '', upgradeOutput: '', autoremoveOutput: '', packagesUpgraded: [], errors: [] };

    const emit = (stage, message) => progressCallback?.({ stage, message });

    try {
        emit('connecting', `Connecting to ${server.name}...`);
        const ssh = await connectToServer(server);
        const sudoExec = makeSudoExec(ssh, server.sudo_password_hash);

        // Step 1: apt-get update
        emit('updating', 'Updating package list...');
        const updateResult = await sudoExec('apt-get update -q', {
            onStdout: chunk => { details.updateOutput += chunk.toString(); },
            onStderr: chunk => { details.updateOutput += chunk.toString(); }
        });
        if (updateResult.code !== 0) throw new Error(`apt-get update failed: ${updateResult.stderr}`);

        // Step 2: apt-get upgrade
        emit('upgrading', 'Upgrading packages...');
        const upgradeResult = await sudoExec('DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -q', {
            onStdout: chunk => {
                const out = chunk.toString();
                details.upgradeOutput += out;
                emit('upgrading', out.trim().slice(-120));
            },
            onStderr: chunk => { details.upgradeOutput += chunk.toString(); }
        });
        if (upgradeResult.code !== 0) throw new Error(`apt-get upgrade failed: ${upgradeResult.stderr}`);

        // Step 3: apt-get autoremove
        emit('autoremove', 'Removing unused packages...');
        const autoremoveResult = await sudoExec('DEBIAN_FRONTEND=noninteractive apt-get autoremove -y -q', {
            onStdout: chunk => { details.autoremoveOutput += chunk.toString(); },
            onStderr: chunk => { details.autoremoveOutput += chunk.toString(); }
        });
        if (autoremoveResult.code !== 0) {
            console.warn(`[update] apt-get autoremove warning for ${server.name}: ${autoremoveResult.stderr}`);
        }

        // Extract upgraded package list
        const pkgMatch = details.upgradeOutput.match(/The following packages will be upgraded:\s*([\s\S]*?)\n\d+ upgraded/);
        if (pkgMatch) {
            details.packagesUpgraded = pkgMatch[1].trim().split(/\s+/).filter(Boolean);
        }
        const countMatch = details.upgradeOutput.match(/(\d+) upgraded/);
        const upgradeCount = countMatch ? parseInt(countMatch[1]) : 0;

        // Check reboot requirement
        const rebootCheck = await sudoExec('sh -c \'[ -f /var/run/reboot-required ] && echo REBOOT_REQUIRED || echo NO_REBOOT\'');
        const needsReboot = rebootCheck.stdout.includes('REBOOT_REQUIRED');

        await dbRun('UPDATE servers SET status = ?, last_update = ?, needs_reboot = ? WHERE id = ?',
            ['updated', new Date().toISOString(), needsReboot ? 1 : 0, server.id]);

        ssh.dispose();

        const message = upgradeCount > 0
            ? `${upgradeCount} package(s) upgraded${needsReboot ? ' — reboot recommended' : ''}`
            : `No packages to upgrade${needsReboot ? ' — reboot recommended' : ''}`;

        emit('completed', message);

        await logUpdate('server', server.id, server.name, updateType, true, message,
            JSON.stringify({
                packagesUpgraded: details.packagesUpgraded,
                upgradeCount,
                needsReboot,
                updateOutput: details.updateOutput.slice(-2000),
                upgradeOutput: details.upgradeOutput.slice(-2000),
                autoremoveOutput: details.autoremoveOutput.slice(-2000)
            })
        );
        notifyUpdate({ entity_type: 'server', entity_name: server.name, update_type: updateType, success: true, message });

        return { success: true, message, needsReboot };

    } catch (error) {
        console.error(`[update] ${server.name}: ${error.message}`);
        await dbRun('UPDATE servers SET status = ? WHERE id = ?', ['failed', server.id]);
        emit('failed', `Update failed: ${error.message}`);

        await logUpdate('server', server.id, server.name, updateType, false, error.message,
            JSON.stringify({ error: error.message, ...details })
        );
        notifyUpdate({ entity_type: 'server', entity_name: server.name, update_type: updateType, success: false, message: error.message });

        return { success: false, message: error.message };
    }
}

async function rebootServer(server) {
    try {
        const ssh = await connectToServer(server);
        const sudoExec = makeSudoExec(ssh, server.sudo_password_hash);
        await sudoExec('reboot');
        ssh.dispose();
        return { success: true, message: 'Server reboot initiated' };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

module.exports = { updateServer, rebootServer, logUpdate };
