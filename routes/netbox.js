const express = require('express');
const { dbAll, dbGet, dbRun } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const { isConfigured, getConfig, netboxRequest, getVMs, getVM } = require('../services/netbox');

const router = express.Router();

router.get('/vms', async (req, res) => {
    if (!await isConfigured()) {
        return res.json({ configured: false, vms: [] });
    }
    try {
        const [vms, existingServers] = await Promise.all([
            getVMs(),
            dbAll('SELECT ip_address FROM servers')
        ]);
        const existingIPs = new Set(existingServers.map(s => s.ip_address));
        const result = vms.map(vm => ({ ...vm, alreadyExists: existingIPs.has(vm.ip) }));
        res.json({ configured: true, vms: result });
    } catch (err) {
        console.error('[netbox] Failed to fetch VMs:', err.message);
        res.status(502).json({ error: `Failed to reach NetBox: ${err.message}` });
    }
});

router.post('/import', async (req, res) => {
    if (!await isConfigured()) {
        return res.status(503).json({ error: 'NetBox is not configured (NETBOX_URL / NETBOX_TOKEN missing)' });
    }

    const { vmIds, credential_id, group_id, port, sudo_password } = req.body;

    if (!Array.isArray(vmIds) || vmIds.length === 0) {
        return res.status(400).json({ error: 'vmIds must be a non-empty array' });
    }
    if (!credential_id) {
        return res.status(400).json({ error: 'credential_id is required' });
    }

    const cred = await dbGet('SELECT * FROM credentials WHERE id = ?', [credential_id]);
    if (!cred) return res.status(400).json({ error: 'Saved credential not found' });

    const existingServers = await dbAll('SELECT ip_address FROM servers');
    const existingIPs = new Set(existingServers.map(s => s.ip_address));

    const sudo_hash = sudo_password ? encrypt(sudo_password) : null;
    const portNum = parseInt(port) || 22;
    const groupId = group_id || null;

    const imported = [];
    const skipped = [];

    for (const vmId of vmIds) {
        let vm;
        try {
            vm = await getVM(vmId);
        } catch (err) {
            skipped.push({ id: vmId, reason: `NetBox fetch failed: ${err.message}` });
            continue;
        }

        if (existingIPs.has(vm.ip)) {
            skipped.push({ name: vm.name, ip: vm.ip, reason: 'IP already exists' });
            continue;
        }

        try {
            await dbRun(
                `INSERT INTO servers (name, ip_address, port, username, auth_type, password_hash, ssh_key_path,
                 sudo_password_hash, group_id, credential_id, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown')`,
                [vm.name, vm.ip, portNum, cred.username, cred.auth_type, null, null,
                 sudo_hash, groupId, credential_id]
            );
            existingIPs.add(vm.ip);
            imported.push({ name: vm.name, ip: vm.ip });
        } catch (err) {
            skipped.push({ name: vm.name, ip: vm.ip, reason: err.message });
        }
    }

    res.json({ imported, skipped });
});

router.get('/docker-vms', async (req, res) => {
    if (!await isConfigured()) {
        return res.json({ configured: false, vms: [] });
    }
    try {
        const [vms, existingHosts] = await Promise.all([
            getVMs(),
            dbAll('SELECT ip_address FROM docker_hosts')
        ]);
        const existingIPs = new Set(existingHosts.map(h => h.ip_address));
        const result = vms.map(vm => ({ ...vm, alreadyExists: existingIPs.has(vm.ip) }));
        res.json({ configured: true, vms: result });
    } catch (err) {
        console.error('[netbox] Failed to fetch VMs for docker:', err.message);
        res.status(502).json({ error: `Failed to reach NetBox: ${err.message}` });
    }
});

router.post('/docker-import', async (req, res) => {
    if (!await isConfigured()) {
        return res.status(503).json({ error: 'NetBox is not configured (NETBOX_URL / NETBOX_TOKEN missing)' });
    }

    const { vmIds, credential_id, group_id, port, sudo_password } = req.body;

    if (!Array.isArray(vmIds) || vmIds.length === 0) {
        return res.status(400).json({ error: 'vmIds must be a non-empty array' });
    }
    if (!credential_id) {
        return res.status(400).json({ error: 'credential_id is required' });
    }

    const cred = await dbGet('SELECT * FROM credentials WHERE id = ?', [credential_id]);
    if (!cred) return res.status(400).json({ error: 'Saved credential not found' });

    const existingHosts = await dbAll('SELECT ip_address FROM docker_hosts');
    const existingIPs = new Set(existingHosts.map(h => h.ip_address));

    const sudo_hash = sudo_password ? encrypt(sudo_password) : null;
    const portNum = parseInt(port) || 22;
    const groupId = group_id || null;

    const imported = [];
    const skipped = [];

    for (const vmId of vmIds) {
        let vm;
        try {
            vm = await getVM(vmId);
        } catch (err) {
            skipped.push({ id: vmId, reason: `NetBox fetch failed: ${err.message}` });
            continue;
        }

        if (existingIPs.has(vm.ip)) {
            skipped.push({ name: vm.name, ip: vm.ip, reason: 'IP already exists' });
            continue;
        }

        try {
            await dbRun(
                `INSERT INTO docker_hosts (name, ip_address, port, username, auth_type, password_hash, ssh_key_path,
                 sudo_password_hash, group_id, credential_id, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown')`,
                [vm.name, vm.ip, portNum, cred.username, cred.auth_type, null, null,
                 sudo_hash, groupId, credential_id]
            );
            existingIPs.add(vm.ip);
            imported.push({ name: vm.name, ip: vm.ip });
        } catch (err) {
            skipped.push({ name: vm.name, ip: vm.ip, reason: err.message });
        }
    }

    res.json({ imported, skipped });
});

router.get('/config', async (req, res) => {
    try {
        const urlRow   = await dbGet("SELECT value FROM plugin_settings WHERE key = 'netbox_url'");
        const tokenRow = await dbGet("SELECT value FROM plugin_settings WHERE key = 'netbox_token'");
        const url = urlRow?.value || process.env.NETBOX_URL || null;
        const token_set = !!(tokenRow?.value || process.env.NETBOX_TOKEN);
        res.json({ url, token_set });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/config', async (req, res) => {
    const { url, token } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    try {
        await dbRun(
            "INSERT OR REPLACE INTO plugin_settings (key, value, updated_at) VALUES ('netbox_url', ?, CURRENT_TIMESTAMP)",
            [url]
        );
        if (token && token.trim()) {
            await dbRun(
                "INSERT OR REPLACE INTO plugin_settings (key, value, updated_at) VALUES ('netbox_token', ?, CURRENT_TIMESTAMP)",
                [encrypt(token.trim())]
            );
        }
        res.json({ message: 'NetBox configuration saved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/test-connection', async (req, res) => {
    try {
        let { url, token } = req.body || {};
        if (!url || !token) {
            const stored = await getConfig();
            url = url || stored.url;
            token = token || stored.token;
        }
        if (!url || !token) {
            return res.status(400).json({ success: false, message: 'NetBox is not configured — enter a URL and token first' });
        }
        const data = await netboxRequest('/api/virtualization/virtual-machines/?limit=1', { url, token });
        res.json({ success: true, message: `Connected to NetBox (${data.count} VMs found)` });
    } catch (err) {
        res.status(502).json({ success: false, message: `Failed to reach NetBox: ${err.message}` });
    }
});

module.exports = router;
