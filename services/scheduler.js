const cron = require('node-cron');
const { dbAll, dbGet } = require('../db');
const { updateServer, rebootServer } = require('./update');
const { updateDockerGroup } = require('./docker');
const { emit: activityEmit } = require('./activity');

const TZ = 'Europe/Amsterdam';

function isUpdateDue(startDate, interval, intervalUnit, lastUpdate) {
    if (!startDate || !interval || !intervalUnit) return false;
    const now = new Date();
    const start = new Date(startDate);
    if (now < start) return false;

    const msMap = { hours: 3600000, days: 86400000, weeks: 604800000, months: 2592000000 };
    const intervalMs = interval * (msMap[intervalUnit] || 0);
    if (!intervalMs) return false;

    if (lastUpdate) {
        const last = new Date(lastUpdate);
        if (last >= start) return (now - last) >= intervalMs;
    }
    return true;
}

function startScheduler() {
    cron.schedule('* * * * *', async () => {
        // Server groups
        try {
            const groups = await dbAll(
                'SELECT * FROM server_groups WHERE auto_update_interval IS NOT NULL AND auto_update_interval_unit IS NOT NULL'
            );
            for (const group of groups) {
                const row = await dbGet('SELECT MAX(last_update) as last_update FROM servers WHERE group_id = ?', [group.id]);
                if (!isUpdateDue(group.auto_update_start_date, group.auto_update_interval, group.auto_update_interval_unit, row?.last_update)) continue;

                const time = new Date().toLocaleString('nl-NL', { timeZone: TZ });
                console.log(`[scheduler] ${time} — Running scheduled update for group: ${group.name}`);

                const servers = await dbAll('SELECT * FROM servers WHERE group_id = ?', [group.id]);
                activityEmit({ type: 'update_start', groupType: 'server', groupName: group.name, total: servers.length });

                for (let i = 0; i < servers.length; i++) {
                    const server = servers[i];
                    activityEmit({ type: 'item_start', groupType: 'server', groupName: group.name, itemName: server.name, current: i + 1, total: servers.length });
                    const result = await updateServer(server, (progress) => {
                        activityEmit({ type: 'item_progress', groupType: 'server', groupName: group.name, itemName: server.name, message: progress.message });
                    }, 'automatic');
                    if (result.success && result.needsReboot && group.auto_reboot_if_required) {
                        console.log(`[scheduler] Auto-rebooting ${server.name}`);
                        activityEmit({ type: 'item_progress', groupType: 'server', groupName: group.name, itemName: server.name, message: 'Rebooting...' });
                        await rebootServer(server);
                    }
                }

                activityEmit({ type: 'update_done', groupType: 'server', groupName: group.name, total: servers.length });
            }
        } catch (err) { console.error('[scheduler] Server group error:', err.message); }

        // Docker groups
        try {
            const dockerGroups = await dbAll(
                'SELECT * FROM docker_groups WHERE auto_update_interval IS NOT NULL AND auto_update_interval_unit IS NOT NULL'
            );
            for (const group of dockerGroups) {
                const row = await dbGet(`
                    SELECT MAX(p.last_update) as last_update
                    FROM docker_compose_projects p JOIN docker_hosts h ON p.host_id = h.id
                    WHERE h.group_id = ?
                `, [group.id]);
                if (!isUpdateDue(group.auto_update_start_date, group.auto_update_interval, group.auto_update_interval_unit, row?.last_update)) continue;
                console.log(`[scheduler] Running scheduled Docker update for group: ${group.name}`);
                const dockerHosts = await dbAll('SELECT * FROM docker_hosts WHERE group_id = ?', [group.id]);
                activityEmit({ type: 'update_start', groupType: 'docker', groupName: group.name, total: dockerHosts.length });
                let hostIndex = 0;
                await updateDockerGroup(group.id, 'automatic', ({ stage, message }) => {
                    try {
                        const d = JSON.parse(message);
                        if (stage === 'host_start') {
                            hostIndex++;
                            activityEmit({ type: 'item_start', groupType: 'docker', groupName: group.name, itemName: d.name, current: hostIndex, total: dockerHosts.length });
                        } else if (stage === 'host_progress') {
                            // d.message is another JSON string: { project, stage, message }
                            let text = '';
                            if (d.stage === 'project_progress' && d.message) {
                                try { const p = JSON.parse(d.message); text = p.project ? `[${p.project}] ${p.message || ''}` : (p.message || ''); } catch { text = d.message; }
                            } else if (d.stage === 'project_start' && d.message) {
                                try { const p = JSON.parse(d.message); text = `Starting: ${p.name || ''} (${p.current}/${p.total})`; } catch {}
                            }
                            if (text) activityEmit({ type: 'item_progress', groupType: 'docker', groupName: group.name, itemName: d.host, message: text });
                        }
                    } catch {}
                });
                activityEmit({ type: 'update_done', groupType: 'docker', groupName: group.name, total: dockerHosts.length });
            }
        } catch (err) { console.error('[scheduler] Docker group error:', err.message); }

    }, { timezone: TZ });

    console.log(`[scheduler] Auto-update scheduler started (checks every minute, TZ: ${TZ})`);
}

module.exports = { startScheduler, isUpdateDue };
