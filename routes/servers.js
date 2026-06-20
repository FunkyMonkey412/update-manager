const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const { dbGet, dbAll, dbRun } = require('../db');
const { encrypt } = require('../utils/crypto');
const { updateServer, rebootServer, backupServerHomeAssistant } = require('../services/update');

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

router.post('/test-truenas-connection', async (req, res) => {
    const { ip_address, truenas_protocol, truenas_verify_ssl } = req.body;
    if (!ip_address) return res.status(400).json({ reachable: false, message: 'IP address is required' });
    const protocol   = truenas_protocol || 'https';
    const port       = protocol === 'https' ? 443 : 80;
    const verifySsl  = truenas_verify_ssl === '1';
    const httpModule = protocol === 'https' ? require('https') : require('http');
    const agent      = protocol === 'https' ? new (require('https').Agent)({ rejectUnauthorized: verifySsl }) : undefined;

    try {
        const statusCode = await new Promise((resolve, reject) => {
            const req2 = httpModule.request(
                { hostname: ip_address, port, path: '/api/v2.0/', method: 'GET', ...(agent ? { agent } : {}) },
                r => resolve(r.statusCode)
            );
            req2.setTimeout(8000, () => { req2.destroy(); reject(new Error('Connection timed out')); });
            req2.on('error', reject);
            req2.end();
        });
        const reachable = statusCode < 500;
        res.json({ reachable, message: reachable
            ? `TrueNAS reachable (HTTP ${statusCode})`
            : `Unexpected response: HTTP ${statusCode}` });
    } catch (err) {
        res.json({ reachable: false, message: err.message });
    }
});

router.post('/test-ha-connection', async (req, res) => {
    const { ip_address, ha_protocol, ha_port, ha_verify_ssl } = req.body;
    if (!ip_address) return res.status(400).json({ reachable: false, message: 'IP address is required' });
    const protocol   = ha_protocol || 'http';
    const port       = parseInt(ha_port) || 8123;
    const verifySsl  = ha_verify_ssl === '1';
    const httpModule = protocol === 'https' ? require('https') : require('http');
    const agent      = protocol === 'https' ? new (require('https').Agent)({ rejectUnauthorized: verifySsl }) : undefined;

    try {
        const statusCode = await new Promise((resolve, reject) => {
            const req2 = httpModule.request(
                { hostname: ip_address, port, path: '/api/', method: 'GET', ...(agent ? { agent } : {}) },
                r => resolve(r.statusCode)
            );
            req2.setTimeout(8000, () => { req2.destroy(); reject(new Error('Connection timed out')); });
            req2.on('error', reject);
            req2.end();
        });
        // 401 = HA responded but no token supplied — still reachable
        const reachable = statusCode < 500 || statusCode === 401;
        res.json({ reachable, message: reachable
            ? `Home Assistant reachable (HTTP ${statusCode})`
            : `Unexpected response: HTTP ${statusCode}` });
    } catch (err) {
        res.json({ reachable: false, message: err.message });
    }
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
    const { name, ip_address, port, username, auth_type, password, sudo_password, group_id, credential_id, os_type,
            truenas_protocol, truenas_verify_ssl,
            ha_protocol, ha_port, ha_verify_ssl } = req.body;
    const sudo_hash = sudo_password ? encrypt(sudo_password) : null;
    const cred_id = credential_id || null;
    const osType = os_type || 'debian';
    const tnProtocol  = osType === 'truenas_ce'     ? (truenas_protocol || 'https') : 'https';
    const tnVerifySSL = osType === 'truenas_ce'     ? (truenas_verify_ssl === '1' ? 1 : 0) : 0;
    const haProtocol  = osType === 'home_assistant' ? (ha_protocol  || 'http')  : 'http';
    const haPort      = osType === 'home_assistant' ? (parseInt(ha_port) || 8123) : 8123;
    const haVerifySSL = osType === 'home_assistant' ? (ha_verify_ssl === '1' ? 1 : 0) : 0;

    let effective_username = username || (osType === 'home_assistant' ? 'homeassistant' : username);
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
        if (!effective_username) effective_username = 'homeassistant';

        const result = await dbRun(
            `INSERT INTO servers (name, ip_address, port, username, auth_type, password_hash, ssh_key_path, sudo_password_hash,
              group_id, credential_id, os_type, truenas_protocol, truenas_verify_ssl, ha_protocol, ha_port, ha_verify_ssl)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, ip_address, port || 22, effective_username, effective_auth_type, password_hash, ssh_key_path, sudo_hash,
             group_id || null, cred_id, osType, tnProtocol, tnVerifySSL, haProtocol, haPort, haVerifySSL]
        );
        res.json({ id: result.lastID, name, ip_address, port: port || 22, username: effective_username, auth_type: effective_auth_type, os_type: osType });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', upload.single('ssh_key'), async (req, res) => {
    const { name, ip_address, port, username, auth_type, password, sudo_password, group_id, credential_id, os_type,
            truenas_protocol, truenas_verify_ssl,
            ha_protocol, ha_port, ha_verify_ssl } = req.body;
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
        if (!effective_username) effective_username = 'homeassistant';

        const osType      = os_type || current.os_type || 'debian';
        const tnProtocol  = osType === 'truenas_ce'     ? (truenas_protocol || current.truenas_protocol || 'https') : 'https';
        const tnVerifySSL = osType === 'truenas_ce'     ? (truenas_verify_ssl === '1' ? 1 : 0) : 0;
        const haProtocol  = osType === 'home_assistant' ? (ha_protocol  || current.ha_protocol  || 'http')  : 'http';
        const haPort      = osType === 'home_assistant' ? (parseInt(ha_port) || current.ha_port || 8123) : 8123;
        const haVerifySSL = osType === 'home_assistant' ? (ha_verify_ssl === '1' ? 1 : 0) : 0;

        await dbRun(
            `UPDATE servers SET name=?, ip_address=?, port=?, username=?, auth_type=?, password_hash=?,
             ssh_key_path=?, sudo_password_hash=?, group_id=?, credential_id=?, os_type=?,
             truenas_protocol=?, truenas_verify_ssl=?, ha_protocol=?, ha_port=?, ha_verify_ssl=? WHERE id=?`,
            [name, ip_address, port || 22, effective_username, effective_auth_type, password_hash, ssh_key_path, sudo_hash,
             group_id || null, cred_id, osType, tnProtocol, tnVerifySSL, haProtocol, haPort, haVerifySSL, req.params.id]
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

router.post('/:id/backup', async (req, res) => {
    try {
        const server = await dbGet('SELECT * FROM servers WHERE id = ?', [req.params.id]);
        if (!server) return res.status(404).json({ error: 'Server not found' });
        if (server.os_type !== 'home_assistant') return res.status(400).json({ error: 'Backup only supported for Home Assistant OS' });
        res.json(await backupServerHomeAssistant(server));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/clear-reboot', async (req, res) => {
    try {
        const server = await dbGet('SELECT * FROM servers WHERE id = ?', [req.params.id]);
        if (!server) return res.status(404).json({ error: 'Server not found' });
        await dbRun('UPDATE servers SET needs_reboot=0 WHERE id=?', [server.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = { router, serverSessions, groupSessions };
