const express = require('express');
const { dbAll, dbGet, dbRun } = require('../db');
const { encrypt } = require('../utils/crypto');
const { isConfigured, getVMs, getVM } = require('../services/netbox');

const router = express.Router();

router.get('/vms', async (req, res) => {
    if (!isConfigured()) {
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
    if (!isConfigured()) {
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
    if (!isConfigured()) {
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
    if (!isConfigured()) {
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

module.exports = router;
