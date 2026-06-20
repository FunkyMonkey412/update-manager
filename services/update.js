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

function makeHAClient(server) {
    const protocol   = server.ha_protocol || 'http';
    const port       = server.ha_port     || 8123;
    const verifySSL  = !!server.ha_verify_ssl;
    const httpModule = protocol === 'https' ? https : http;
    const agent      = protocol === 'https' ? new https.Agent({ rejectUnauthorized: verifySSL }) : undefined;
    return { httpModule, agent, port };
}

async function resolveHAToken(server) {
    let token;
    if (server.credential_id) {
        const cred = await dbGet('SELECT * FROM credentials WHERE id = ?', [server.credential_id]);
        if (!cred) throw new Error('Saved credential not found');
        token = cred.password_hash ? decrypt(cred.password_hash) : null;
    } else {
        token = server.password_hash ? decrypt(server.password_hash) : null;
    }
    if (!token) throw new Error('A long-lived access token is required for Home Assistant');
    return token;
}

function makeHARequest(server, token, { httpModule, agent, port }) {
    return (method, path, body = null) => new Promise((resolve, reject) => {
        const payload = body !== null ? JSON.stringify(body) : null;
        const req = httpModule.request({
            hostname: server.ip_address,
            port,
            path,
            method,
            ...(agent ? { agent } : {}),
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 400) return reject(new Error(`HA API ${res.statusCode}: ${data}`));
                try { resolve(JSON.parse(data)); } catch { resolve(data); }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function rebootServerHomeAssistant(server) {
    try {
        const token  = await resolveHAToken(server);
        const client = makeHAClient(server);
        const apiRequest = makeHARequest(server, token, client);

        await new Promise((resolve, reject) => {
            const payload = '{}';
            const req = client.httpModule.request({
                hostname: server.ip_address,
                port: client.port,
                path: '/api/services/hassio/host_reboot',
                method: 'POST',
                ...(client.agent ? { agent: client.agent } : {}),
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            }, () => resolve());
            req.on('error', err => {
                if (['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND'].includes(err.code)) resolve();
                else reject(err);
            });
            req.write(payload);
            req.end();
        });

        await dbRun('UPDATE servers SET needs_reboot=0 WHERE id=?', [server.id]);
        return { success: true, message: 'Home Assistant reboot initiated' };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

async function backupServerHomeAssistant(server) {
    try {
        const token   = await resolveHAToken(server);
        const client  = makeHAClient(server);
        const payload = '{}';
        await new Promise((resolve, reject) => {
            const req = client.httpModule.request({
                hostname: server.ip_address,
                port:     client.port,
                path:     '/api/services/hassio/backup_full',
                method:   'POST',
                ...(client.agent ? { agent: client.agent } : {}),
                headers: {
                    Authorization:   `Bearer ${token}`,
                    'Content-Type':  'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            }, () => resolve());
            // HA may drop the connection while starting the backup — treat as success
            req.on('error', err => {
                if (['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'socket hang up'].includes(err.code || err.message))
                    resolve();
                else
                    reject(err);
            });
            req.write(payload);
            req.end();
        });
        return { success: true, message: 'Backup started — HA is creating a full backup in the background' };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

async function updateServerHomeAssistant(server, progressCallback = null, updateType = 'manual') {
    const emit = (stage, message) => progressCallback?.({ stage, message });

    try {
        const token  = await resolveHAToken(server);
        const client = makeHAClient(server);
        const apiRequest = makeHARequest(server, token, client);

        const apiGet  = path        => apiRequest('GET',  path);
        const apiPost = (path, body) => apiRequest('POST', path, body);

        emit('connecting', `Connecting to ${server.name}...`);

        // Check Core update via entity state
        emit('checking', 'Checking for HA Core update...');
        let coreUpdated = false;
        let coreVersion = null;
        let coreEntity;
        try {
            coreEntity = await apiGet('/api/states/update.home_assistant_core_update');
        } catch (e) {
            throw new Error(`Cannot reach Home Assistant at ${server.ip_address}:${client.port} — ${e.message}`);
        }

        if (coreEntity?.state === 'on') {
            coreVersion = coreEntity.attributes?.latest_version;
            const current = coreEntity.attributes?.installed_version || 'unknown';
            emit('updating', `Updating HA Core ${current} → ${coreVersion}...`);
            try {
                await apiPost('/api/services/update/install', { entity_id: 'update.home_assistant_core_update', backup: false });
            } catch { /* connection drop while HA core restarts */ }
            coreUpdated = true;
        } else {
            const ver = coreEntity?.attributes?.installed_version || 'unknown';
            emit('checking', `HA Core is up to date (${ver})`);
        }

        if (coreUpdated) await new Promise(r => setTimeout(r, 5000));

        // Check OS update via entity state
        emit('checking', 'Checking for HA OS update...');
        let osUpdated = false;
        let osVersion = null;
        let needsReboot = false;
        let osEntity;
        try {
            osEntity = await apiGet('/api/states/update.home_assistant_operating_system_update');
        } catch {
            osEntity = { state: 'off' };
        }

        if (osEntity?.state === 'on') {
            osVersion = osEntity.attributes?.latest_version;
            const current = osEntity.attributes?.installed_version || 'unknown';
            emit('updating', `Updating HA OS ${current} → ${osVersion} — system will reboot...`);
            try {
                await apiPost('/api/services/update/install', { entity_id: 'update.home_assistant_operating_system_update', backup: false });
            } catch { /* connection drop on reboot */ }
            osUpdated = true;
            needsReboot = true;
        } else {
            const ver = osEntity?.attributes?.installed_version || 'unknown';
            emit('checking', `HA OS is up to date (${ver})`);
        }

        if (!coreUpdated && !osUpdated) {
            await dbRun('UPDATE servers SET status=?, last_update=? WHERE id=?',
                ['updated', new Date().toISOString(), server.id]);
            const message = 'No updates available';
            emit('completed', message);
            await logUpdate('server', server.id, server.name, updateType, true, message, JSON.stringify({ available: false }));
            notifyUpdate({ entity_type: 'server', entity_name: server.name, update_type: updateType, success: true, message });
            return { success: true, message, needsReboot: false };
        }

        const parts = [];
        if (coreUpdated) parts.push(`Core → ${coreVersion}`);
        if (osUpdated)   parts.push(`OS → ${osVersion} (rebooting)`);

        await dbRun('UPDATE servers SET status=?, last_update=?, needs_reboot=? WHERE id=?',
            ['updated', new Date().toISOString(), needsReboot ? 1 : 0, server.id]);

        const message = `Home Assistant updated: ${parts.join(', ')}`;
        emit('completed', message);
        await logUpdate('server', server.id, server.name, updateType, true, message,
            JSON.stringify({ coreUpdated, coreVersion, osUpdated, osVersion, needsReboot }));
        notifyUpdate({ entity_type: 'server', entity_name: server.name, update_type: updateType, success: true, message });
        return { success: true, message, needsReboot };

    } catch (error) {
        console.error(`[update] HomeAssistant ${server.name}: ${error.message}`);
        await dbRun('UPDATE servers SET status=? WHERE id=?', ['failed', server.id]);
        emit('failed', `Update failed: ${error.message}`);
        await logUpdate('server', server.id, server.name, updateType, false, error.message, JSON.stringify({ error: error.message }));
        notifyUpdate({ entity_type: 'server', entity_name: server.name, update_type: updateType, success: false, message: error.message });
        return { success: false, message: error.message };
    }
}

async function updateServer(server, progressCallback = null, updateType = 'manual') {
    if (server.os_type === 'truenas_ce')     return updateServerTrueNAS(server, progressCallback, updateType);
    if (server.os_type === 'home_assistant') return updateServerHomeAssistant(server, progressCallback, updateType);

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
    if (server.os_type === 'home_assistant') return rebootServerHomeAssistant(server);
    try {
        const ssh = await connectToServer(server);
        const sudoExec = makeSudoExec(ssh, server.sudo_password_hash);
        await sudoExec('reboot');
        ssh.dispose();
        await dbRun('UPDATE servers SET needs_reboot=0 WHERE id=?', [server.id]);
        return { success: true, message: 'Server reboot initiated' };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

module.exports = { updateServer, rebootServer, backupServerHomeAssistant, logUpdate };
