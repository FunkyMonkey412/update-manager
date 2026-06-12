const express = require('express');
const multer = require('multer');
const fs = require('fs');

const { dbGet, dbAll, dbRun } = require('../db');
const { encrypt } = require('../utils/crypto');
const { updateDockerComposeProject, updateDockerHost, updateDockerGroup, validatePath, connectToDockerHost } = require('../services/docker');

const router = express.Router();
const upload = multer({ dest: 'ssh-keys/' });

const projectSessions = new Map();
const hostSessions = new Map();
const dockerGroupSessions = new Map();

// ── Docker Groups ─────────────────────────────────────────────────────────────

router.get('/groups', async (req, res) => {
    try { res.json(await dbAll('SELECT * FROM docker_groups ORDER BY name')); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/groups/:id', async (req, res) => {
    try {
        const g = await dbGet('SELECT * FROM docker_groups WHERE id = ?', [req.params.id]);
        if (!g) return res.status(404).json({ error: 'Docker group not found' });
        res.json(g);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/groups', async (req, res) => {
    const { name, description, auto_update_interval, auto_update_interval_unit, auto_update_start_date } = req.body;
    try {
        const result = await dbRun(
            `INSERT INTO docker_groups (name, description, auto_update_interval, auto_update_interval_unit, auto_update_start_date)
             VALUES (?, ?, ?, ?, ?)`,
            [name, description, auto_update_interval || null, auto_update_interval_unit || null, auto_update_start_date || null]
        );
        res.json({ id: result.lastID, name, description });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/groups/:id', async (req, res) => {
    const { name, description, auto_update_interval, auto_update_interval_unit, auto_update_start_date } = req.body;
    try {
        const result = await dbRun(
            `UPDATE docker_groups SET name=?, description=?, auto_update_interval=?,
             auto_update_interval_unit=?, auto_update_start_date=? WHERE id=?`,
            [name, description, auto_update_interval || null, auto_update_interval_unit || null,
             auto_update_start_date || null, req.params.id]
        );
        if (result.changes === 0) return res.status(404).json({ error: 'Group not found' });
        res.json({ message: 'Group updated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/groups/:id', async (req, res) => {
    try {
        const result = await dbRun('DELETE FROM docker_groups WHERE id = ?', [req.params.id]);
        if (result.changes === 0) return res.status(404).json({ error: 'Group not found' });
        res.json({ message: 'Group deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/groups/:id/update-stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    dockerGroupSessions.set(req.params.id, res);
    res.write(`data: ${JSON.stringify({ stage: 'initializing', message: 'Preparing Docker group update...' })}\n\n`);
    req.on('close', () => dockerGroupSessions.delete(req.params.id));
});

router.post('/groups/:id/update', async (req, res) => {
    try {
        const emit = data => {
            const sseRes = dockerGroupSessions.get(req.params.id);
            if (sseRes) sseRes.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        const result = await updateDockerGroup(req.params.id, 'manual', emit);
        emit({ stage: 'finished', ...result });
        const sseRes = dockerGroupSessions.get(req.params.id);
        if (sseRes) { sseRes.end(); dockerGroupSessions.delete(req.params.id); }
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Docker Hosts ──────────────────────────────────────────────────────────────

router.get('/hosts', async (req, res) => {
    try {
        const rows = await dbAll(`
            SELECT h.*, g.name as group_name,
                   (SELECT COUNT(*) FROM docker_compose_projects WHERE host_id = h.id) as project_count
            FROM docker_hosts h LEFT JOIN docker_groups g ON h.group_id = g.id ORDER BY h.name
        `);
        res.json(rows.map(r => ({
            ...r,
            password_hash: r.password_hash ? '[CONFIGURED]' : undefined,
            ssh_key_path: r.ssh_key_path ? '[CONFIGURED]' : undefined,
            sudo_password_hash: r.sudo_password_hash ? '[CONFIGURED]' : undefined
        })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/hosts/:id', async (req, res) => {
    try {
        const h = await dbGet('SELECT * FROM docker_hosts WHERE id = ?', [req.params.id]);
        if (!h) return res.status(404).json({ error: 'Docker host not found' });
        res.json({
            ...h,
            password_hash: h.password_hash ? '[CONFIGURED]' : undefined,
            ssh_key_path: h.ssh_key_path ? '[CONFIGURED]' : undefined,
            sudo_password_hash: h.sudo_password_hash ? '[CONFIGURED]' : undefined
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/hosts/test-connection', async (req, res) => {
    const { ip_address, port, username, auth_type, password, ssh_key_path, sudo_password } = req.body;
    try {
        const { connectToDockerHost } = require('../services/docker');
        const tempHost = {
            name: 'test', ip_address, port: port || 22, username, auth_type,
            password_hash: password ? encrypt(password) : null,
            ssh_key_path: ssh_key_path || null,
            sudo_password_hash: sudo_password ? encrypt(sudo_password) : null
        };
        // connectToDockerHost is not exported; use connectToServer directly
        const { connectToServer, makeSudoExec } = require('../services/ssh');
        const ssh = await connectToServer(tempHost);
        const sudoExec = makeSudoExec(ssh, tempHost.sudo_password_hash);
        let composeCommand = 'unknown';
        try {
            const v2 = await sudoExec('docker compose version');
            composeCommand = v2.code === 0 ? 'docker compose' : 'docker-compose';
        } catch {}
        ssh.dispose();
        res.json({ success: true, message: `Connection successful. Detected: ${composeCommand}`, composeCommand });
    } catch (err) {
        res.json({ success: false, message: `Connection failed: ${err.message}` });
    }
});

router.post('/hosts', upload.single('ssh_key'), async (req, res) => {
    const { name, ip_address, port, username, auth_type, password, sudo_password, group_id, credential_id } = req.body;
    const sudo_hash = sudo_password ? encrypt(sudo_password) : null;
    const cred_id = credential_id || null;

    let effective_username = username;
    let effective_auth_type = auth_type;
    let password_hash = null;
    let ssh_key_path = null;

    try {
        if (cred_id) {
            const cred = await dbGet('SELECT * FROM credentials WHERE id = ?', [cred_id]);
            if (!cred) return res.status(400).json({ error: 'Saved credential not found' });
            effective_username = cred.username;
            effective_auth_type = cred.auth_type;
        } else {
            password_hash = auth_type === 'password' ? encrypt(password) : null;
            ssh_key_path = auth_type === 'ssh_key' && req.file ? req.file.path : null;
        }

        const result = await dbRun(
            `INSERT INTO docker_hosts (name, ip_address, port, username, auth_type, password_hash, ssh_key_path, sudo_password_hash, group_id, credential_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, ip_address, port || 22, effective_username, effective_auth_type, password_hash, ssh_key_path, sudo_hash, group_id || null, cred_id]
        );
        res.json({ id: result.lastID, name, ip_address });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/hosts/:id', upload.single('ssh_key'), async (req, res) => {
    const { name, ip_address, port, username, auth_type, password, sudo_password, group_id, credential_id } = req.body;
    try {
        const existing = await dbGet('SELECT * FROM docker_hosts WHERE id = ?', [req.params.id]);
        if (!existing) return res.status(404).json({ error: 'Docker host not found' });

        const cred_id = credential_id || null;
        let effective_username = username;
        let effective_auth_type = auth_type;
        let password_hash = existing.password_hash;
        let ssh_key_path = existing.ssh_key_path;
        let sudo_hash = existing.sudo_password_hash;

        if (cred_id) {
            const cred = await dbGet('SELECT * FROM credentials WHERE id = ?', [cred_id]);
            if (!cred) return res.status(400).json({ error: 'Saved credential not found' });
            effective_username = cred.username;
            effective_auth_type = cred.auth_type;
            password_hash = null;
            ssh_key_path = null;
        } else {
            if (auth_type === 'password' && password) {
                password_hash = encrypt(password);
                if (existing.auth_type === 'ssh_key' && existing.ssh_key_path) {
                    fs.unlink(existing.ssh_key_path, () => {});
                    ssh_key_path = null;
                }
            } else if (auth_type === 'ssh_key' && req.file) {
                if (existing.ssh_key_path) fs.unlink(existing.ssh_key_path, () => {});
                ssh_key_path = req.file.path;
                password_hash = null;
            }
        }
        if (sudo_password) sudo_hash = encrypt(sudo_password);

        const result = await dbRun(
            `UPDATE docker_hosts SET name=?, ip_address=?, port=?, username=?, auth_type=?, password_hash=?,
             ssh_key_path=?, sudo_password_hash=?, group_id=?, credential_id=? WHERE id=?`,
            [name, ip_address, port || 22, effective_username, effective_auth_type, password_hash, ssh_key_path, sudo_hash,
             group_id || null, cred_id, req.params.id]
        );
        if (result.changes === 0) return res.status(404).json({ error: 'Docker host not found' });
        res.json({ message: 'Docker host updated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/hosts/:id', async (req, res) => {
    try {
        const host = await dbGet('SELECT ssh_key_path FROM docker_hosts WHERE id = ?', [req.params.id]);
        if (!host) return res.status(404).json({ error: 'Docker host not found' });
        await dbRun('DELETE FROM docker_hosts WHERE id = ?', [req.params.id]);
        if (host.ssh_key_path && fs.existsSync(host.ssh_key_path)) fs.unlink(host.ssh_key_path, () => {});
        res.json({ message: 'Docker host deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/hosts/:id/update-stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    hostSessions.set(req.params.id, res);
    res.write(`data: ${JSON.stringify({ stage: 'initializing', message: 'Preparing host update...' })}\n\n`);
    req.on('close', () => hostSessions.delete(req.params.id));
});

router.post('/hosts/:id/update', async (req, res) => {
    try {
        const emit = data => {
            const sseRes = hostSessions.get(req.params.id);
            if (sseRes) sseRes.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        const result = await updateDockerHost(req.params.id, 'manual', emit);
        emit({ stage: 'finished', ...result });
        const sseRes = hostSessions.get(req.params.id);
        if (sseRes) { sseRes.end(); hostSessions.delete(req.params.id); }
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/hosts/:id/discover', async (req, res) => {
    const { root_path, max_depth = 3 } = req.body;
    try {
        validatePath(root_path);
        const depth = Math.min(Math.max(parseInt(max_depth) || 3, 1), 8);

        const host = await dbGet('SELECT * FROM docker_hosts WHERE id = ?', [req.params.id]);
        if (!host) return res.status(404).json({ error: 'Docker host not found' });

        const { ssh, sudoExec } = await connectToDockerHost(host);
        const findCmd = `find ${root_path} -maxdepth ${depth} -type f 2>/dev/null | grep -E "/(docker-compose|compose)\\.(yml|yaml)$" | sort`;
        const result = await sudoExec(findCmd);
        ssh.dispose();

        const composePaths = (result.stdout || '')
            .split('\n').map(l => l.trim()).filter(l => l.length > 0);

        const existing = await dbAll('SELECT compose_file_path FROM docker_compose_projects WHERE host_id = ?', [req.params.id]);
        const registeredPaths = new Set(existing.map(p => p.compose_file_path));

        const found = [], alreadyRegistered = [];
        for (const composePath of composePaths) {
            const workingDirectory = composePath.substring(0, composePath.lastIndexOf('/'));
            const name = workingDirectory.substring(workingDirectory.lastIndexOf('/') + 1);
            const entry = { name, composePath, workingDirectory };
            (registeredPaths.has(composePath) ? alreadyRegistered : found).push(entry);
        }

        res.json({ found, alreadyRegistered });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Docker Projects ───────────────────────────────────────────────────────────

router.get('/projects', async (req, res) => {
    try {
        const { host_id } = req.query;
        const query = host_id
            ? `SELECT p.*, h.name as host_name FROM docker_compose_projects p
               JOIN docker_hosts h ON p.host_id = h.id WHERE p.host_id = ? ORDER BY p.name`
            : `SELECT p.*, h.name as host_name FROM docker_compose_projects p
               JOIN docker_hosts h ON p.host_id = h.id ORDER BY h.name, p.name`;
        res.json(await dbAll(query, host_id ? [host_id] : []));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id', async (req, res) => {
    try {
        const p = await dbGet(
            `SELECT p.*, h.name as host_name FROM docker_compose_projects p
             JOIN docker_hosts h ON p.host_id = h.id WHERE p.id = ?`, [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Docker project not found' });
        res.json(p);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/projects', async (req, res) => {
    const { host_id, name, compose_file_path, working_directory } = req.body;
    try {
        validatePath(compose_file_path);
        validatePath(working_directory);
        const result = await dbRun(
            `INSERT INTO docker_compose_projects (host_id, name, compose_file_path, working_directory) VALUES (?, ?, ?, ?)`,
            [host_id, name, compose_file_path, working_directory]
        );
        res.json({ id: result.lastID, host_id, name, compose_file_path, working_directory });
    } catch (err) {
        if (err.message.includes('UNIQUE constraint')) return res.status(400).json({ error: 'Compose path already exists for this host' });
        res.status(err.message.startsWith('Invalid') || err.message.startsWith('Path') ? 400 : 500).json({ error: err.message });
    }
});

router.put('/projects/:id', async (req, res) => {
    const { name, compose_file_path, working_directory } = req.body;
    try {
        validatePath(compose_file_path);
        validatePath(working_directory);
        const result = await dbRun(
            `UPDATE docker_compose_projects SET name=?, compose_file_path=?, working_directory=? WHERE id=?`,
            [name, compose_file_path, working_directory, req.params.id]
        );
        if (result.changes === 0) return res.status(404).json({ error: 'Project not found' });
        res.json({ message: 'Project updated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/projects/:id', async (req, res) => {
    try {
        const result = await dbRun('DELETE FROM docker_compose_projects WHERE id = ?', [req.params.id]);
        if (result.changes === 0) return res.status(404).json({ error: 'Project not found' });
        res.json({ message: 'Project deleted' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/projects/:id/update-stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    projectSessions.set(req.params.id, res);
    res.write(`data: ${JSON.stringify({ stage: 'initializing', message: 'Preparing Docker update...' })}\n\n`);
    req.on('close', () => projectSessions.delete(req.params.id));
});

router.post('/projects/:id/update', async (req, res) => {
    try {
        const project = await dbGet(`
            SELECT p.*, h.name as host_name, h.ip_address, h.port, h.username,
                   h.auth_type, h.password_hash, h.ssh_key_path, h.sudo_password_hash, h.docker_compose_command, h.credential_id
            FROM docker_compose_projects p JOIN docker_hosts h ON p.host_id = h.id WHERE p.id = ?
        `, [req.params.id]);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const emit = progress => {
            const sseRes = projectSessions.get(req.params.id);
            if (sseRes) sseRes.write(`data: ${JSON.stringify(progress)}\n\n`);
        };

        const result = await updateDockerComposeProject(project, emit);

        const sseRes = projectSessions.get(req.params.id);
        if (sseRes) {
            sseRes.write(`data: ${JSON.stringify({ stage: 'finished', result })}\n\n`);
            sseRes.end();
            projectSessions.delete(req.params.id);
        }
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = { router };
