const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const { dbGet, dbAll, dbRun } = require('../db');
const { encrypt } = require('../utils/crypto');
const { updateServer, rebootServer } = require('../services/update');

const router = express.Router();
const upload = multer({ dest: 'ssh-keys/' });

// Active SSE sessions: serverId → res, groupId → res
const serverSessions = new Map();
const groupSessions = new Map();

// ── Servers ──────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    try {
        const rows = await dbAll(`
            SELECT s.*, g.name as group_name
            FROM servers s LEFT JOIN server_groups g ON s.group_id = g.id
            ORDER BY s.name
        `);
        res.json(rows.map(r => ({ ...r, password_hash: undefined, sudo_password_hash: undefined, ssh_key_path: r.ssh_key_path ? 'configured' : undefined })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/test-connection', async (req, res) => {
    const { ip_address, port, username } = req.body;
    try {
        const cmd = `ssh -o ConnectTimeout=10 -o BatchMode=yes -o PasswordAuthentication=no -o PubkeyAuthentication=no ${username}@${ip_address} -p ${port || 22} exit 2>&1`;
        let output = '';
        try { await execAsync(cmd); } catch (e) { output = e.stderr || e.stdout || ''; }

        const methods = [];
        if (output.includes('publickey')) methods.push('ssh_key');
        if (output.includes('password')) methods.push('password');
        if (!methods.length && !output.includes('Connection refused') && !output.includes('timeout'))
            methods.push('ssh_key', 'password');

        res.json({
            reachable: !output.includes('Connection refused') && !output.includes('timeout') && !output.includes('unreachable'),
            supportedAuthMethods: methods,
            message: methods.length ? `Server reachable. Auth: ${methods.join(', ')}` : 'Connection test failed.'
        });
    } catch (err) { res.json({ reachable: false, supportedAuthMethods: [], message: err.message }); }
});

router.post('/', upload.single('ssh_key'), async (req, res) => {
    const { name, ip_address, port, username, auth_type, password, sudo_password, group_id, credential_id, os_type, truenas_protocol, truenas_verify_ssl } = req.body;
    const sudo_hash = sudo_password ? encrypt(sudo_password) : null;
    const cred_id = credential_id || null;
    const osType = os_type || 'debian';
    const tnProtocol = osType === 'truenas_ce' ? (truenas_protocol || 'https') : 'https';
    const tnVerifySSL = osType === 'truenas_ce' ? (truenas_verify_ssl === '1' ? 1 : 0) : 0;

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
            `INSERT INTO servers (name, ip_address, port, username, auth_type, password_hash, ssh_key_path, sudo_password_hash, group_id, credential_id, os_type, truenas_protocol, truenas_verify_ssl)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, ip_address, port || 22, effective_username, effective_auth_type, password_hash, ssh_key_path, sudo_hash, group_id || null, cred_id, osType, tnProtocol, tnVerifySSL]
        );
        res.json({ id: result.lastID, name, ip_address, port: port || 22, username: effective_username, auth_type: effective_auth_type, os_type: osType });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', upload.single('ssh_key'), async (req, res) => {
    const { name, ip_address, port, username, auth_type, password, sudo_password, group_id, credential_id, os_type, truenas_protocol, truenas_verify_ssl } = req.body;
    try {
        const current = await dbGet('SELECT * FROM servers WHERE id = ?', [req.params.id]);
        if (!current) return res.status(404).json({ error: 'Server not found' });

        const cred_id = credential_id || null;
        let effective_username = username;
        let effective_auth_type = auth_type;
        let password_hash = current.password_hash;
        let ssh_key_path = current.ssh_key_path;
        let sudo_hash = current.sudo_password_hash;

        if (cred_id) {
            const cred = await dbGet('SELECT * FROM credentials WHERE id = ?', [cred_id]);
            if (!cred) return res.status(400).json({ error: 'Saved credential not found' });
            effective_username = cred.username;
            effective_auth_type = cred.auth_type;
            password_hash = null;
            ssh_key_path = null;
        } else {
            if (auth_type === 'password' && password) password_hash = encrypt(password);
            if (auth_type === 'ssh_key' && req.file) {
                if (current.ssh_key_path && fs.existsSync(current.ssh_key_path)) fs.unlinkSync(current.ssh_key_path);
                ssh_key_path = req.file.path;
            }
        }
        if (sudo_password) sudo_hash = encrypt(sudo_password);

        const osType = os_type || current.os_type || 'debian';
        const tnProtocol = osType === 'truenas_ce' ? (truenas_protocol || current.truenas_protocol || 'https') : 'https';
        const tnVerifySSL = osType === 'truenas_ce' ? (truenas_verify_ssl === '1' ? 1 : 0) : 0;
        await dbRun(
            `UPDATE servers SET name=?, ip_address=?, port=?, username=?, auth_type=?, password_hash=?,
             ssh_key_path=?, sudo_password_hash=?, group_id=?, credential_id=?, os_type=?, truenas_protocol=?, truenas_verify_ssl=? WHERE id=?`,
            [name, ip_address, port || 22, effective_username, effective_auth_type, password_hash, ssh_key_path, sudo_hash,
             group_id || null, cred_id, osType, tnProtocol, tnVerifySSL, req.params.id]
        );
        res.json({ id: req.params.id, name, ip_address, port: port || 22, username: effective_username, auth_type: effective_auth_type, os_type: osType });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
    try {
        const server = await dbGet('SELECT * FROM servers WHERE id = ?', [req.params.id]);
        if (!server) return res.status(404).json({ error: 'Server not found' });
        if (server.ssh_key_path && fs.existsSync(server.ssh_key_path)) fs.unlinkSync(server.ssh_key_path);
        await dbRun('DELETE FROM servers WHERE id = ?', [req.params.id]);
        res.json({ message: 'Server deleted successfully' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Update / Reboot ───────────────────────────────────────────────────────────

router.get('/:id/update-stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });
    serverSessions.set(req.params.id, res);
    res.write(`data: ${JSON.stringify({ stage: 'initializing', message: 'Preparing update...' })}\n\n`);
    req.on('close', () => serverSessions.delete(req.params.id));
});

router.post('/:id/update', async (req, res) => {
    try {
        const server = await dbGet('SELECT * FROM servers WHERE id = ?', [req.params.id]);
        if (!server) return res.status(404).json({ error: 'Server not found' });

        const emit = progress => {
            const sseRes = serverSessions.get(req.params.id);
            if (sseRes) sseRes.write(`data: ${JSON.stringify(progress)}\n\n`);
        };

        const result = await updateServer(server, emit);

        const sseRes = serverSessions.get(req.params.id);
        if (sseRes) {
            sseRes.write(`data: ${JSON.stringify({ stage: 'finished', result })}\n\n`);
            sseRes.end();
            serverSessions.delete(req.params.id);
        }
        res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/reboot', async (req, res) => {
    try {
        const server = await dbGet('SELECT * FROM servers WHERE id = ?', [req.params.id]);
        if (!server) return res.status(404).json({ error: 'Server not found' });
        res.json(await rebootServer(server));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = { router, serverSessions, groupSessions };
