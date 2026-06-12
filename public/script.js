// ── State ─────────────────────────────────────────────────────────────────────
let servers = [];
let groups = [];
let dockerHosts = [];
let dockerProjects = [];
let dockerGroups = [];

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// SQLite CURRENT_TIMESTAMP stores UTC without 'Z'; append it so JS parses correctly
function parseDbDate(str) {
    if (!str) return null;
    return new Date(str.includes('T') || str.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(str) ? str : str.replace(' ', 'T') + 'Z');
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    showTab('dashboard');
    loadDashboard();
    loadServers();
    loadGroups();
    loadDockerHosts();
    loadDockerProjects();
    loadDockerGroups();
    loadLogs();
    loadCredentials();
    loadWebhooks();

    initActivityStream();

    document.getElementById('add-server-form').addEventListener('submit', handleAddServer);
    document.getElementById('add-group-form').addEventListener('submit', handleAddGroup);
    document.getElementById('edit-server-form').addEventListener('submit', handleEditServer);
    document.getElementById('edit-group-form').addEventListener('submit', handleEditGroup);
    document.getElementById('add-docker-host-form').addEventListener('submit', handleAddDockerHost);
    document.getElementById('add-docker-group-form').addEventListener('submit', handleAddDockerGroup);
    document.getElementById('add-docker-project-form').addEventListener('submit', handleAddDockerProject);
    document.getElementById('edit-docker-host-form').addEventListener('submit', handleEditDockerHost);
    document.getElementById('edit-docker-project-form').addEventListener('submit', handleEditDockerProject);
    document.getElementById('edit-docker-group-form').addEventListener('submit', handleEditDockerGroup);
    document.getElementById('add-credential-form').addEventListener('submit', handleAddCredential);
    document.getElementById('add-webhook-form').addEventListener('submit', handleAddWebhook);

    // Close modals on backdrop click (single listener — fix #8)
    document.addEventListener('click', (e) => {
        const modals = [
            { id: 'edit-server-modal', close: closeEditModal },
            { id: 'edit-group-modal', close: closeEditGroupModal },
            { id: 'add-docker-project-modal', close: closeAddProjectModal },
            { id: 'edit-docker-host-modal', close: closeEditDockerHostModal },
            { id: 'edit-docker-project-modal', close: closeEditDockerProjectModal },
            { id: 'edit-docker-group-modal', close: closeEditDockerGroupModal },
            { id: 'netbox-import-modal', close: closeNetboxImportModal },
            { id: 'add-server-modal', close: closeAddServerModal },
            { id: 'add-group-modal', close: closeAddGroupModal },
            { id: 'add-docker-host-modal', close: closeAddDockerHostModal },
            { id: 'add-docker-group-modal', close: closeAddDockerGroupModal },
            { id: 'add-credential-modal', close: closeAddCredentialModal },
            { id: 'add-webhook-modal', close: closeAddWebhookModal },
            { id: 'netbox-docker-import-modal', close: closeNetboxDockerImportModal },
            { id: 'discover-modal', close: closeDiscoverModal }
        ];
        for (const { id, close } of modals) {
            const modal = document.getElementById(id);
            if (modal && e.target === modal) { close(); break; }
        }
    });
});

// ── Tab switching ─────────────────────────────────────────────────────────────
function showTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(el => {
        el.classList.add('hidden');
        el.setAttribute('data-active', 'false');
    });
    document.querySelectorAll('.tab-button').forEach(btn => btn.setAttribute('data-active', 'false'));

    const tab = document.getElementById(tabName);
    if (tab) { tab.classList.remove('hidden'); tab.setAttribute('data-active', 'true'); }

    document.querySelectorAll('.tab-button').forEach(btn => {
        const match = btn.getAttribute('onclick')?.match(/showTab\('([^']+)'\)/);
        if (match && match[1] === tabName) btn.setAttribute('data-active', 'true');
    });
}

function toggleSection(sectionId) {
    const section = document.getElementById(sectionId);
    const icon = document.getElementById(`${sectionId}-icon`);
    const isHidden = section.classList.contains('hidden');
    section.classList.toggle('hidden', !isHidden);
    section.classList.toggle('flex', isHidden);
    section.classList.toggle('flex-col', isHidden);
    icon.classList.toggle('-rotate-90', !isHidden);
    icon.classList.toggle('rotate-0', isHidden);
}

// ── Auth field toggling (consolidated — fix #7) ───────────────────────────────
function toggleAuthFields(prefix = '') {
    const id = prefix ? `${prefix}-auth-type` : 'auth-type';
    const authType = document.getElementById(id)?.value;
    const pfx = prefix || '';
    const passwordField = document.getElementById(pfx ? `${pfx}-password-field` : 'password-field');
    const sshKeyField = document.getElementById(pfx ? `${pfx}-ssh-key-field` : 'ssh-key-field');
    const pwdInput = document.getElementById(pfx ? `${pfx}-host-password` : 'server-password');
    const keyInput = document.getElementById(pfx ? `${pfx}-ssh-key` : 'ssh-key');

    if (passwordField) passwordField.classList.toggle('hidden', authType !== 'password');
    if (sshKeyField) sshKeyField.classList.toggle('hidden', authType !== 'ssh_key');
    if (pwdInput) pwdInput.required = authType === 'password';
    if (keyInput) keyInput.required = authType === 'ssh_key';
}

// Wrappers called from HTML onchange attributes
function toggleDockerAuthFields()     { toggleAuthFields('docker'); }
function toggleEditAuthFields()       { toggleAuthFields('edit'); }
function toggleEditDockerAuthFields() { toggleAuthFields('edit-docker'); }

// ── Status helpers ────────────────────────────────────────────────────────────
function getStatusColor(status) {
    return { online: 'bg-green-500', offline: 'bg-red-500', updating: 'bg-yellow-500',
             updated: 'bg-blue-500', failed: 'bg-red-500', unknown: 'bg-gray-500' }[status] || 'bg-gray-500';
}

// ── Toast notifications (fix #9: use dedicated class) ─────────────────────────
function showSuccess(message) {
    _showToast(message, 'bg-green-600',
        'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z');
}

function showError(message) {
    _showToast(message, 'bg-red-600',
        'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z');
}

function _showToast(message, bgClass, iconPath) {
    document.querySelectorAll('.toast-message').forEach(el => el.remove());
    const div = document.createElement('div');
    div.className = `toast-message fixed top-4 right-4 ${bgClass} text-white px-6 py-4 rounded-lg shadow-lg z-50 flex items-center space-x-3`;
    div.innerHTML = `<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${iconPath}"></path></svg>
        <span>${escapeHtml(message)}</span>`;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 5000);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
    try {
        const data = await fetch('/api/dashboard').then(r => r.json());
        renderDashboard(data);
    } catch (err) { console.error('Dashboard load failed:', err); }
}

function renderDashboard(data) {
    const { servers, dockerHosts, dockerProjects, recentLogs } = data;

    // Server stat cards
    const serverCards = document.getElementById('dash-server-stats');
    if (serverCards) {
        serverCards.innerHTML = [
            { label: 'Total Servers', value: servers.total, color: 'text-white' },
            { label: 'Up to Date', value: servers.updated || 0, color: 'text-blue-400' },
            { label: 'Failed', value: servers.failed || 0, color: servers.failed ? 'text-red-400' : 'text-slate-400' },
            { label: 'Needs Reboot', value: servers.needsReboot || 0, color: servers.needsReboot ? 'text-yellow-400' : 'text-slate-400' }
        ].map(stat => `
            <div class="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5 text-center">
                <div class="text-3xl font-bold ${stat.color} mb-1">${stat.value}</div>
                <div class="text-sm text-slate-400">${stat.label}</div>
            </div>`).join('');
    }

    // Docker stat cards
    const dockerCards = document.getElementById('dash-docker-stats');
    if (dockerCards) {
        dockerCards.innerHTML = [
            { label: 'Docker Hosts', value: dockerHosts || 0, color: 'text-white' },
            { label: 'Total Projects', value: dockerProjects.total || 0, color: 'text-white' },
            { label: 'Up to Date', value: dockerProjects.updated || 0, color: 'text-blue-400' },
            { label: 'Failed', value: dockerProjects.failed || 0, color: dockerProjects.failed ? 'text-red-400' : 'text-slate-400' }
        ].map(stat => `
            <div class="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5 text-center">
                <div class="text-3xl font-bold ${stat.color} mb-1">${stat.value}</div>
                <div class="text-sm text-slate-400">${stat.label}</div>
            </div>`).join('');
    }

    // Recent logs
    const recentEl = document.getElementById('dash-recent-logs');
    if (recentEl) {
        if (!recentLogs || recentLogs.length === 0) {
            recentEl.innerHTML = '<div class="text-center py-6 text-slate-400 text-sm">No updates performed yet</div>';
            return;
        }
        recentEl.innerHTML = recentLogs.map(log => {
            const icon = log.entity_type === 'docker' ? '🐳' : '🖥️';
            const ts = parseDbDate(log.timestamp).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });
            const statusClass = log.success ? 'text-green-400' : 'text-red-400';
            return `<div class="flex items-center gap-3 py-2 border-b border-slate-700/50 last:border-0">
                <span class="text-base">${icon}</span>
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-white truncate">${escapeHtml(log.entity_name)}</div>
                    <div class="text-xs text-slate-400 truncate">${escapeHtml(log.message)}</div>
                </div>
                <div class="text-right shrink-0">
                    <div class="text-xs ${statusClass} font-medium">${log.success ? '✓ OK' : '✗ Failed'}</div>
                    <div class="text-xs text-slate-500">${ts}</div>
                </div>
            </div>`;
        }).join('');
    }
}

// ── Servers ───────────────────────────────────────────────────────────────────
async function loadServers() {
    try {
        const res = await fetch('/api/servers');
        servers = await res.json();
        displayServers();
    } catch { showError('Failed to load servers'); }
}

function displayServers() {
    const el = document.getElementById('servers-list');
    if (!servers.length) {
        el.innerHTML = '<div class="col-span-full text-center py-12 text-slate-400">No servers configured yet. Add your first server!</div>';
        return;
    }
    el.innerHTML = servers.map(s => `
        <div class="bg-slate-800/50 backdrop-blur-sm border border-slate-700/50 rounded-xl p-5 hover:border-slate-600 transition-all duration-200 hover:shadow-lg hover:shadow-blue-500/10">
            <div class="flex justify-between items-start mb-4">
                <h3 class="text-lg font-semibold text-white">${escapeHtml(s.name)}</h3>
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(s.status)} text-white">
                    ${escapeHtml(s.status || 'unknown')}
                </span>
            </div>
            <div class="space-y-2 mb-4 text-sm">
                <p class="text-slate-300"><span class="text-slate-400">IP:</span> ${escapeHtml(s.ip_address)}:${escapeHtml(String(s.port))}</p>
                <p class="text-slate-300"><span class="text-slate-400">User:</span> ${escapeHtml(s.username)}</p>
                <p class="text-slate-300"><span class="text-slate-400">Auth:</span> ${escapeHtml(s.auth_type)}</p>
                <p class="text-slate-300"><span class="text-slate-400">Group:</span> ${escapeHtml(s.group_name || 'None')}</p>
                ${s.needs_reboot ? '<p class="text-yellow-400 text-xs font-medium">⚠ Reboot recommended</p>' : ''}
                ${s.last_update ? `<p class="text-slate-300"><span class="text-slate-400">Updated:</span> ${new Date(s.last_update).toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam' })}</p>` : ''}
            </div>
            <div class="grid grid-cols-2 gap-2">
                <button onclick="editServer(${s.id})" class="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg text-sm font-medium transition-all">Edit</button>
                <button onclick="updateServer(${s.id})" class="px-3 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white rounded-lg text-sm font-medium transition-all">Update</button>
                <button onclick="rebootServer(${s.id})" class="px-3 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white rounded-lg text-sm font-medium transition-all">Reboot</button>
                <button onclick="deleteServer(${s.id})" class="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg text-sm font-medium transition-all">Delete</button>
            </div>
        </div>`).join('');
}

async function refreshServers() {
    try { await loadServers(); showSuccess('Servers refreshed'); }
    catch { showError('Failed to refresh servers'); }
}

async function handleAddServer(e) {
    e.preventDefault();
    try {
        const res = await fetch('/api/servers', { method: 'POST', body: new FormData(e.target) });
        if (res.ok) { showSuccess('Server added!'); e.target.reset(); closeAddServerModal(); await loadServers(); }
        else { const err = await res.json(); showError(err.error || 'Failed to add server'); }
    } catch { showError('Failed to add server'); }
}

async function updateServer(serverId) {
    const server = servers.find(s => s.id === serverId);
    if (!server) return;
    showUpdateProgress(escapeHtml(server.name));

    const eventSource = new EventSource(`/api/servers/${serverId}/update-stream`);
    eventSource.onmessage = e => {
        const progress = JSON.parse(e.data);
        updateProgressDisplay(progress, 'server');
        if (progress.stage === 'finished') {
            eventSource.close();
            setTimeout(() => {
                hideUpdateProgress();
                progress.result.success ? showSuccess(progress.result.message) : showError(progress.result.message);
                loadServers(); loadLogs(); loadDashboard();
            }, 2000);
        }
    };
    eventSource.onerror = () => { eventSource.close(); hideUpdateProgress(); showError('Update stream connection failed'); };

    try {
        const res = await fetch(`/api/servers/${serverId}/update`, { method: 'POST' });
        if (!res.ok) throw new Error('Failed to start update');
    } catch (err) { eventSource.close(); hideUpdateProgress(); showError(err.message); }
}

async function rebootServer(serverId) {
    const server = servers.find(s => s.id === serverId);
    if (!confirm(`Reboot "${escapeHtml(server?.name || serverId)}"?`)) return;
    try {
        const res = await fetch(`/api/servers/${serverId}/reboot`, { method: 'POST' });
        const result = await res.json();
        result.success ? showSuccess(result.message) : showError(result.message);
    } catch { showError('Failed to reboot server'); }
}

function editServer(serverId) {
    const server = servers.find(s => s.id === serverId);
    if (!server) return;
    document.getElementById('edit-server-id').value = server.id;
    document.getElementById('edit-server-name').value = server.name;
    document.getElementById('edit-server-ip').value = server.ip_address;
    document.getElementById('edit-server-port').value = server.port;
    document.getElementById('edit-server-username').value = server.username;
    document.getElementById('edit-auth-type').value = server.auth_type;
    loadGroupsForEditSelect();
    document.getElementById('edit-server-group').value = server.group_id || '';

    const credPicker = document.getElementById('edit-server-credential');
    if (credPicker) {
        credPicker.value = server.credential_id || '';
        applyCredentialToForm(credPicker, 'edit-server');
    } else {
        toggleAuthFields('edit');
    }

    const modal = document.getElementById('edit-server-modal');
    modal.classList.remove('hidden'); modal.classList.add('flex');
}

function closeEditModal() {
    const modal = document.getElementById('edit-server-modal');
    modal.classList.add('hidden'); modal.classList.remove('flex');
    document.getElementById('edit-server-form').reset();
}

async function handleEditServer(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const serverId = formData.get('server_id');
    try {
        const res = await fetch(`/api/servers/${serverId}`, { method: 'PUT', body: formData });
        if (res.ok) { showSuccess('Server updated!'); closeEditModal(); await loadServers(); }
        else { const err = await res.json(); showError(err.error || 'Failed to update server'); }
    } catch { showError('Failed to update server'); }
}

async function deleteServer(serverId) {
    const server = servers.find(s => s.id === serverId);
    if (!confirm(`Delete "${escapeHtml(server?.name || serverId)}"? This cannot be undone.`)) return;
    try {
        const res = await fetch(`/api/servers/${serverId}`, { method: 'DELETE' });
        if (res.ok) { showSuccess('Server deleted'); await loadServers(); }
        else { const err = await res.json(); showError(err.error || 'Failed to delete server'); }
    } catch { showError('Failed to delete server'); }
}

async function testConnection() {
    const ip_address = document.getElementById('server-ip').value;
    const port = document.getElementById('server-port').value || 22;
    const username = document.getElementById('server-username').value;
    if (!ip_address || !username) return showError('Enter IP address and username first');

    const resultDiv = document.getElementById('connection-test-result');
    resultDiv.innerHTML = '<div class="text-blue-400">Testing connection...</div>';
    try {
        const res = await fetch('/api/servers/test-connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip_address, port, username })
        });
        const result = await res.json();
        if (result.reachable) {
            resultDiv.innerHTML = `<div class="text-green-400 mb-1">✅ ${escapeHtml(result.message)}</div>`;
            const authSelect = document.getElementById('auth-type');
            if (result.supportedAuthMethods.includes('ssh_key') && !result.supportedAuthMethods.includes('password'))
                authSelect.value = 'ssh_key';
            else if (result.supportedAuthMethods.includes('password') && !result.supportedAuthMethods.includes('ssh_key'))
                authSelect.value = 'password';
            toggleAuthFields();
        } else {
            resultDiv.innerHTML = `<div class="text-red-400">❌ ${escapeHtml(result.message)}</div>`;
        }
    } catch (err) {
        resultDiv.innerHTML = `<div class="text-red-400">❌ ${escapeHtml(err.message)}</div>`;
    }
}

// ── Groups ────────────────────────────────────────────────────────────────────
async function loadGroups() {
    try {
        const res = await fetch('/api/groups');
        groups = await res.json();
        displayGroups(); loadGroupsForSelect(); loadGroupsForEditSelect();
    } catch { showError('Failed to load groups'); }
}

function displayGroups() {
    const el = document.getElementById('groups-list');
    if (!groups.length) {
        el.innerHTML = '<div class="col-span-full text-center py-12 text-slate-400">No groups configured. Create your first group!</div>';
        return;
    }
    el.innerHTML = groups.map(g => {
        let schedule = '';
        if (g.auto_update_interval && g.auto_update_interval_unit) {
            schedule = `Every ${escapeHtml(String(g.auto_update_interval))} ${escapeHtml(g.auto_update_interval_unit)}`;
            if (g.auto_update_start_date)
                schedule += `, from ${new Date(g.auto_update_start_date).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}`;
            if (g.auto_reboot_if_required) schedule += ' <span class="text-cyan-400">(auto-reboot)</span>';
        }
        const members = servers.filter(s => s.group_id === g.id);
        const membersHtml = members.length
            ? `<div class="mt-3 mb-4">
                <p class="text-xs text-slate-500 uppercase tracking-wide mb-2">Members (${members.length})</p>
                <div class="space-y-1">
                    ${members.map(s => `<div class="flex items-center justify-between text-sm px-2 py-1 bg-slate-700/50 rounded-lg">
                        <span class="text-slate-200 font-medium">${escapeHtml(s.name)}</span>
                        <span class="text-slate-400 font-mono text-xs">${escapeHtml(s.ip_address)}</span>
                    </div>`).join('')}
                </div>
            </div>`
            : `<p class="text-xs text-slate-500 mt-3 mb-4 italic">No servers in this group</p>`;
        return `
        <div class="bg-slate-800/50 backdrop-blur-sm border border-slate-700/50 rounded-xl p-5 hover:border-slate-600 transition-all duration-200">
            <h3 class="text-lg font-semibold text-white mb-2">${escapeHtml(g.name)}</h3>
            <p class="text-slate-300 text-sm mb-3">${escapeHtml(g.description || 'No description')}</p>
            ${schedule ? `<p class="text-sm text-slate-400"><span class="text-slate-500">Schedule:</span> ${schedule}</p>` : ''}
            ${membersHtml}
            <div class="grid grid-cols-3 gap-2">
                <button onclick="editGroup(${g.id})" class="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg text-sm font-medium transition-all">Edit</button>
                <button onclick="updateGroupWithProgress(${g.id})" class="px-3 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white rounded-lg text-sm font-medium transition-all">Update</button>
                <button onclick="deleteGroup(${g.id})" class="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg text-sm font-medium transition-all">Delete</button>
            </div>
        </div>`;
    }).join('');
}

function loadGroupsForSelect() {
    ['server-group'].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = '<option value="">No Group</option>' +
            groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
    });
}

function loadGroupsForEditSelect() {
    const sel = document.getElementById('edit-server-group');
    if (!sel) return;
    sel.innerHTML = '<option value="">No Group</option>' +
        groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
}

async function refreshGroups() {
    try { await loadGroups(); showSuccess('Groups refreshed'); }
    catch { showError('Failed to refresh groups'); }
}

async function handleAddGroup(e) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    if (data.auto_update_start_date) data.auto_update_start_date = new Date(data.auto_update_start_date).toISOString();
    try {
        const res = await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (res.ok) { showSuccess('Group created!'); e.target.reset(); closeAddGroupModal(); await loadGroups(); }
        else { const err = await res.json(); showError(err.error || 'Failed to create group'); }
    } catch { showError('Failed to create group'); }
}

async function updateGroupWithProgress(groupId) {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    showGroupProgress(escapeHtml(group.name));

    const eventSource = new EventSource(`/api/groups/${groupId}/update-stream`);
    eventSource.onmessage = e => {
        const progress = JSON.parse(e.data);
        updateGroupProgressDisplay(progress);
        if (progress.stage === 'finished') {
            eventSource.close();
            setTimeout(() => {
                hideUpdateProgress();
                showSuccess(progress.message || 'Group update complete');
                loadServers(); loadLogs(); loadDashboard();
            }, 2000);
        }
    };
    eventSource.onerror = () => { eventSource.close(); hideUpdateProgress(); showError('Group update stream failed'); };

    try {
        await fetch(`/api/groups/${groupId}/update`, { method: 'POST' });
    } catch (err) { eventSource.close(); hideUpdateProgress(); showError(err.message); }
}

function editGroup(groupId) {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    document.getElementById('edit-group-id').value = group.id;
    document.getElementById('edit-group-name').value = group.name;
    document.getElementById('edit-group-description').value = group.description || '';
    document.getElementById('edit-auto-update-interval').value = group.auto_update_interval || '';
    document.getElementById('edit-auto-update-interval-unit').value = group.auto_update_interval_unit || '';
    document.getElementById('edit-auto-reboot-if-required').checked = !!group.auto_reboot_if_required;
    if (group.auto_update_start_date) {
        const d = new Date(group.auto_update_start_date);
        document.getElementById('edit-auto-update-start-date').value =
            `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    } else { document.getElementById('edit-auto-update-start-date').value = ''; }
    const modal = document.getElementById('edit-group-modal');
    modal.classList.remove('hidden'); modal.classList.add('flex');
}

function closeEditGroupModal() {
    const modal = document.getElementById('edit-group-modal');
    modal.classList.add('hidden'); modal.classList.remove('flex');
    document.getElementById('edit-group-form').reset();
}

async function handleEditGroup(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const groupId = formData.get('group_id');
    const data = Object.fromEntries(formData);
    delete data.group_id;
    if (data.auto_update_start_date) data.auto_update_start_date = new Date(data.auto_update_start_date).toISOString();
    try {
        const res = await fetch(`/api/groups/${groupId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (res.ok) { showSuccess('Group updated!'); closeEditGroupModal(); await loadGroups(); }
        else { const err = await res.json(); showError(err.error || 'Failed to update group'); }
    } catch { showError('Failed to update group'); }
}

async function deleteGroup(groupId) {
    const group = groups.find(g => g.id === groupId);
    if (!confirm(`Delete group "${escapeHtml(group?.name || groupId)}"?`)) return;
    try {
        const res = await fetch(`/api/groups/${groupId}`, { method: 'DELETE' });
        if (res.ok) { showSuccess('Group deleted'); await loadGroups(); }
        else { const err = await res.json(); showError(err.error || 'Failed to delete group'); }
    } catch { showError('Failed to delete group'); }
}

// ── Progress modals ───────────────────────────────────────────────────────────
function showUpdateProgress(name) {
    let modal = document.getElementById('progress-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'progress-modal';
        modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl max-w-2xl w-full">
                <div class="flex justify-between items-center px-6 py-4 border-b border-slate-700">
                    <h2 class="text-xl font-semibold text-white">Update Progress</h2>
                </div>
                <div class="p-6 space-y-4">
                    <div id="progress-title" class="text-lg font-medium bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent"></div>
                    <div id="progress-stage" class="text-base font-semibold text-white"></div>
                    <div id="progress-message" class="text-sm text-slate-300 min-h-[40px]"></div>
                    <div class="w-full bg-slate-700/50 rounded-full h-3 overflow-hidden border border-slate-600">
                        <div id="progress-bar-fill" class="h-full bg-gradient-to-r from-blue-600 to-cyan-600 transition-all duration-300" style="width:0%"></div>
                    </div>
                    <div id="progress-logs" class="max-h-[200px] overflow-y-auto bg-slate-900/50 border border-slate-700 p-4 rounded-lg font-mono text-xs text-slate-300"></div>
                </div>
            </div>`;
        document.body.appendChild(modal);
    } else { modal.classList.remove('hidden'); modal.classList.add('flex'); }

    document.getElementById('progress-title').textContent = `Updating: ${name}`;
    document.getElementById('progress-stage').textContent = 'Initializing...';
    document.getElementById('progress-message').textContent = '';
    document.getElementById('progress-bar-fill').style.width = '0%';
    document.getElementById('progress-logs').innerHTML = '';
}

function showGroupProgress(groupName) {
    showUpdateProgress(`Group: ${groupName}`);
}

function hideUpdateProgress() {
    const modal = document.getElementById('progress-modal');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
}

function updateProgressDisplay(progress, type = 'server') {
    const stages = type === 'docker'
        ? { initializing: '🔄 Initializing...', connecting: '🔌 Connecting...', pulling: '⬇️ Pulling images...', recreating: '🔄 Recreating containers...', completed: '✅ Done!', failed: '❌ Failed' }
        : { initializing: '🔄 Initializing...', connecting: '🔌 Connecting...', updating: '📋 Updating package list...', upgrading: '⬆️ Upgrading packages...', autoremove: '🧹 Removing old packages...', completed: '✅ Done!', failed: '❌ Failed' };

    const pcts = type === 'docker'
        ? { initializing: 10, connecting: 20, pulling: 50, recreating: 80, completed: 100, failed: 100 }
        : { initializing: 10, connecting: 20, updating: 35, upgrading: 65, autoremove: 85, completed: 100, failed: 100 };

    const stageEl = document.getElementById('progress-stage');
    const msgEl = document.getElementById('progress-message');
    const bar = document.getElementById('progress-bar-fill');
    const logsEl = document.getElementById('progress-logs');

    if (stageEl) stageEl.textContent = stages[progress.stage] || progress.stage;
    if (msgEl && progress.message) msgEl.textContent = progress.message;
    if (bar) {
        bar.style.width = `${pcts[progress.stage] || 0}%`;
        bar.className = 'h-full transition-all duration-300 ' + (
            progress.stage === 'failed' ? 'bg-gradient-to-r from-red-600 to-red-500' :
            progress.stage === 'completed' ? 'bg-gradient-to-r from-green-600 to-green-500' :
            'bg-gradient-to-r from-blue-600 to-cyan-600'
        );
    }
    if (logsEl && progress.message && ['upgrading', 'pulling', 'recreating', 'autoremove'].includes(progress.stage)) {
        const entry = document.createElement('div');
        entry.className = 'mb-1';
        entry.textContent = `${new Date().toLocaleTimeString()}: ${progress.message}`;
        logsEl.appendChild(entry);
        logsEl.scrollTop = logsEl.scrollHeight;
    }
}

function updateGroupProgressDisplay(progress) {
    const stageEl = document.getElementById('progress-stage');
    const msgEl = document.getElementById('progress-message');
    const bar = document.getElementById('progress-bar-fill');
    const logsEl = document.getElementById('progress-logs');

    if (progress.stage === 'starting') {
        if (stageEl) stageEl.textContent = `🔄 ${escapeHtml(progress.message)}`;
        if (bar) bar.style.width = '5%';
    } else if (progress.stage === 'server_start') {
        if (stageEl) stageEl.textContent = `🖥️ Updating ${escapeHtml(progress.server)} (${progress.current}/${progress.total})`;
        if (bar) bar.style.width = `${Math.round((progress.current - 1) / progress.total * 90) + 5}%`;
    } else if (progress.stage === 'server_progress') {
        if (msgEl) msgEl.textContent = `${escapeHtml(progress.server)}: ${escapeHtml(progress.message || '')}`;
        if (logsEl && progress.message) {
            const entry = document.createElement('div');
            entry.className = 'mb-1';
            entry.textContent = `${progress.server}: ${progress.message}`;
            logsEl.appendChild(entry);
            logsEl.scrollTop = logsEl.scrollHeight;
        }
    } else if (progress.stage === 'finished') {
        if (stageEl) stageEl.textContent = '✅ All done!';
        if (bar) { bar.style.width = '100%'; bar.className = 'h-full transition-all duration-300 bg-gradient-to-r from-green-600 to-green-500'; }
    }
}

// ── Docker Hosts ──────────────────────────────────────────────────────────────
async function loadDockerHosts() {
    try {
        const res = await fetch('/api/docker/hosts');
        dockerHosts = await res.json();
        displayDockerHosts(); populateHostFilter();
    } catch { showError('Failed to load Docker hosts'); }
}

function displayDockerHosts() {
    const el = document.getElementById('docker-hosts-list');
    if (!dockerHosts.length) {
        el.innerHTML = '<div class="col-span-full text-center py-12 text-slate-400">No Docker hosts configured yet.</div>';
        return;
    }
    el.innerHTML = dockerHosts.map(h => `
        <div class="bg-slate-800/50 backdrop-blur-sm border border-slate-700/50 rounded-xl p-5 hover:border-slate-600 transition-all">
            <div class="flex justify-between items-start mb-4">
                <h3 class="text-lg font-semibold text-white">${escapeHtml(h.name)}</h3>
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(h.status)} text-white">${escapeHtml(h.status || 'unknown')}</span>
            </div>
            <div class="space-y-2 mb-4 text-sm">
                <p class="text-slate-300"><span class="text-slate-400">IP:</span> ${escapeHtml(h.ip_address)}:${escapeHtml(String(h.port))}</p>
                <p class="text-slate-300"><span class="text-slate-400">User:</span> ${escapeHtml(h.username)}</p>
                <p class="text-slate-300"><span class="text-slate-400">Docker:</span> ${escapeHtml(h.docker_compose_command || 'Not detected')}</p>
                <p class="text-slate-300"><span class="text-slate-400">Projects:</span> ${h.project_count}</p>
                <p class="text-slate-300"><span class="text-slate-400">Group:</span> ${escapeHtml(h.group_name || 'None')}</p>
                ${h.last_update ? `<p class="text-slate-300"><span class="text-slate-400">Updated:</span> ${new Date(h.last_update).toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam' })}</p>` : ''}
            </div>
            <div class="grid grid-cols-4 gap-2">
                <button onclick="showAddProjectModal(${h.id}, '${escapeHtml(h.name).replace(/'/g, "\\'")}')" class="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg text-sm font-medium transition-all">Add Project</button>
                <button onclick="editDockerHost(${h.id})" class="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg text-sm font-medium transition-all">Edit</button>
                <button onclick="updateDockerHostWithProgress(${h.id})" class="px-3 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white rounded-lg text-sm font-medium transition-all">Update All</button>
                <button onclick="deleteDockerHost(${h.id})" class="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg text-sm font-medium transition-all">Delete</button>
            </div>
            <button onclick="showDiscoverModal(${h.id})" class="mt-2 w-full px-3 py-2 bg-teal-700/30 hover:bg-teal-700/50 border border-teal-600/40 text-teal-300 rounded-lg text-sm font-medium transition-all">
                Discover Projects
            </button>
        </div>`).join('');
}

async function refreshDockerHosts() {
    try { await loadDockerHosts(); showSuccess('Docker hosts refreshed'); }
    catch { showError('Failed to refresh Docker hosts'); }
}

async function handleAddDockerHost(e) {
    e.preventDefault();
    try {
        const res = await fetch('/api/docker/hosts', { method: 'POST', body: new FormData(e.target) });
        if (res.ok) { showSuccess('Docker host added!'); e.target.reset(); closeAddDockerHostModal(); await loadDockerHosts(); loadDockerGroupsForSelect(); }
        else { const err = await res.json(); showError(err.error || 'Failed to add Docker host'); }
    } catch { showError('Failed to add Docker host'); }
}

async function editDockerHost(id) {
    try {
        const res = await fetch(`/api/docker/hosts/${id}`);
        const host = await res.json();
        document.getElementById('edit-docker-host-id').value = host.id;
        document.getElementById('edit-docker-host-name').value = host.name;
        document.getElementById('edit-docker-host-ip').value = host.ip_address;
        document.getElementById('edit-docker-host-port').value = host.port;
        document.getElementById('edit-docker-host-username').value = host.username;
        document.getElementById('edit-docker-auth-type').value = host.auth_type;
        const sel = document.getElementById('edit-docker-group');
        sel.innerHTML = '<option value="">No Group</option>' +
            dockerGroups.map(g => `<option value="${g.id}" ${g.id === host.group_id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('');

        const credPicker = document.getElementById('edit-docker-credential');
        if (credPicker) {
            credPicker.value = host.credential_id || '';
            applyCredentialToForm(credPicker, 'edit-docker');
        } else {
            toggleAuthFields('edit-docker');
        }

        const modal = document.getElementById('edit-docker-host-modal');
        modal.classList.remove('hidden'); modal.classList.add('flex');
    } catch { showError('Failed to load Docker host details'); }
}

function closeEditDockerHostModal() {
    const modal = document.getElementById('edit-docker-host-modal');
    modal.classList.add('hidden'); modal.classList.remove('flex');
    document.getElementById('edit-docker-host-form').reset();
}

async function handleEditDockerHost(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const hostId = formData.get('id');
    try {
        const res = await fetch(`/api/docker/hosts/${hostId}`, { method: 'PUT', body: formData });
        if (res.ok) { showSuccess('Docker host updated!'); closeEditDockerHostModal(); await loadDockerHosts(); await loadDockerProjects(); }
        else { const err = await res.json(); showError(err.error || 'Failed to update Docker host'); }
    } catch { showError('Failed to update Docker host'); }
}

async function deleteDockerHost(hostId) {
    const host = dockerHosts.find(h => h.id === hostId);
    if (!confirm(`Delete host "${escapeHtml(host?.name || hostId)}"? All associated projects will be deleted too.`)) return;
    try {
        const res = await fetch(`/api/docker/hosts/${hostId}`, { method: 'DELETE' });
        if (res.ok) { showSuccess('Docker host deleted'); await loadDockerHosts(); await loadDockerProjects(); }
        else { const err = await res.json(); showError(err.error || 'Failed to delete Docker host'); }
    } catch { showError('Failed to delete Docker host'); }
}

async function updateDockerHostWithProgress(hostId) {
    const host = dockerHosts.find(h => h.id === hostId);
    if (!confirm(`Update all projects on "${escapeHtml(host?.name || hostId)}"?`)) return;
    showUpdateProgress(`Host: ${escapeHtml(host?.name || hostId)}`);

    const eventSource = new EventSource(`/api/docker/hosts/${hostId}/update-stream`);
    eventSource.onmessage = e => {
        const progress = JSON.parse(e.data);
        if (progress.stage === 'project_progress') {
            const inner = JSON.parse(progress.message);
            updateProgressDisplay(inner, 'docker');
        } else if (progress.stage === 'project_start') {
            const inner = JSON.parse(progress.message);
            document.getElementById('progress-title').textContent = `Updating project: ${escapeHtml(inner.name)} (${inner.current}/${inner.total})`;
        } else if (progress.stage === 'finished') {
            eventSource.close();
            setTimeout(() => {
                hideUpdateProgress();
                const count = (progress.results || []).filter(r => r.success).length;
                showSuccess(`Updated ${count} of ${(progress.results || []).length} project(s)`);
                loadDockerHosts(); loadDockerProjects(); loadLogs(); loadDashboard();
            }, 2000);
        }
    };
    eventSource.onerror = () => { eventSource.close(); hideUpdateProgress(); showError('Host update stream failed'); };

    try { await fetch(`/api/docker/hosts/${hostId}/update`, { method: 'POST' }); }
    catch (err) { eventSource.close(); hideUpdateProgress(); showError(err.message); }
}

// ── Docker Projects ───────────────────────────────────────────────────────────
async function loadDockerProjects(hostId = null) {
    try {
        const url = hostId ? `/api/docker/projects?host_id=${hostId}` : '/api/docker/projects';
        const res = await fetch(url);
        dockerProjects = await res.json();
        displayDockerProjects();
    } catch { showError('Failed to load Docker projects'); }
}

function displayDockerProjects() {
    const el = document.getElementById('docker-projects-list');
    if (!dockerProjects.length) {
        el.innerHTML = '<div class="col-span-full text-center py-12 text-slate-400">No Docker projects configured yet.</div>';
        return;
    }
    el.innerHTML = dockerProjects.map(p => `
        <div class="bg-slate-800/50 backdrop-blur-sm border border-slate-700/50 rounded-xl p-5 hover:border-slate-600 transition-all">
            <div class="flex justify-between items-start mb-4">
                <div>
                    <h3 class="text-lg font-semibold text-white">${escapeHtml(p.name)}</h3>
                    <p class="text-sm text-slate-400">${escapeHtml(p.host_name)}</p>
                </div>
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(p.status)} text-white">${escapeHtml(p.status || 'unknown')}</span>
            </div>
            <div class="space-y-2 mb-4 text-sm">
                <p class="text-slate-300 truncate" title="${escapeHtml(p.compose_file_path)}"><span class="text-slate-400">Compose:</span> ${escapeHtml(p.compose_file_path)}</p>
                <p class="text-slate-300 truncate" title="${escapeHtml(p.working_directory)}"><span class="text-slate-400">Dir:</span> ${escapeHtml(p.working_directory)}</p>
                ${p.last_update ? `<p class="text-slate-300"><span class="text-slate-400">Updated:</span> ${new Date(p.last_update).toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam' })}</p>` : ''}
            </div>
            <div class="grid grid-cols-3 gap-2">
                <button onclick="editDockerProject(${p.id})" class="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg text-sm font-medium transition-all">Edit</button>
                <button onclick="updateDockerProject(${p.id})" class="px-3 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white rounded-lg text-sm font-medium transition-all">Update</button>
                <button onclick="deleteDockerProject(${p.id})" class="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg text-sm font-medium transition-all">Delete</button>
            </div>
        </div>`).join('');
}

function populateHostFilter() {
    const sel = document.getElementById('filter-host');
    if (!sel) return;
    sel.innerHTML = '<option value="">All Hosts</option>' +
        dockerHosts.map(h => `<option value="${h.id}">${escapeHtml(h.name)}</option>`).join('');
}

function filterProjectsByHost() {
    const hostId = document.getElementById('filter-host').value;
    loadDockerProjects(hostId || null);
}

async function refreshDockerProjects() {
    try { await loadDockerProjects(); showSuccess('Docker projects refreshed'); }
    catch { showError('Failed to refresh Docker projects'); }
}

function showAddProjectModal(hostId, hostName) {
    document.getElementById('project-host-id').value = hostId;
    document.getElementById('project-host-display').textContent = hostName;
    const modal = document.getElementById('add-docker-project-modal');
    modal.classList.remove('hidden'); modal.classList.add('flex');
}

function closeAddProjectModal() {
    const modal = document.getElementById('add-docker-project-modal');
    modal.classList.add('hidden'); modal.classList.remove('flex');
    document.getElementById('add-docker-project-form').reset();
}

async function handleAddDockerProject(e) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
        const res = await fetch('/api/docker/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (res.ok) { showSuccess('Docker project added!'); closeAddProjectModal(); await loadDockerProjects(); await loadDockerHosts(); }
        else { const err = await res.json(); showError(err.error || 'Failed to add project'); }
    } catch { showError('Failed to add Docker project'); }
}

async function editDockerProject(id) {
    try {
        const res = await fetch(`/api/docker/projects/${id}`);
        const p = await res.json();
        document.getElementById('edit-project-id').value = p.id;
        document.getElementById('edit-project-name').value = p.name;
        document.getElementById('edit-project-compose-path').value = p.compose_file_path;
        document.getElementById('edit-project-working-dir').value = p.working_directory;
        const modal = document.getElementById('edit-docker-project-modal');
        modal.classList.remove('hidden'); modal.classList.add('flex');
    } catch { showError('Failed to load Docker project details'); }
}

function closeEditDockerProjectModal() {
    const modal = document.getElementById('edit-docker-project-modal');
    modal.classList.add('hidden'); modal.classList.remove('flex');
    document.getElementById('edit-docker-project-form').reset();
}

async function handleEditDockerProject(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const projectId = formData.get('id');
    const data = Object.fromEntries(formData);
    try {
        const res = await fetch(`/api/docker/projects/${projectId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (res.ok) { showSuccess('Project updated!'); closeEditDockerProjectModal(); await loadDockerProjects(); }
        else { const err = await res.json(); showError(err.error || 'Failed to update project'); }
    } catch { showError('Failed to update Docker project'); }
}

async function deleteDockerProject(projectId) {
    const p = dockerProjects.find(x => x.id === projectId);
    if (!confirm(`Delete project "${escapeHtml(p?.name || projectId)}"?`)) return;
    try {
        const res = await fetch(`/api/docker/projects/${projectId}`, { method: 'DELETE' });
        if (res.ok) { showSuccess('Project deleted'); await loadDockerProjects(); }
        else { const err = await res.json(); showError(err.error || 'Failed to delete project'); }
    } catch { showError('Failed to delete Docker project'); }
}

async function updateDockerProject(projectId) {
    const project = dockerProjects.find(p => p.id === projectId);
    if (!project) return;
    showUpdateProgress(`Docker: ${escapeHtml(project.name)}`);

    const eventSource = new EventSource(`/api/docker/projects/${projectId}/update-stream`);
    eventSource.onmessage = e => {
        const progress = JSON.parse(e.data);
        updateProgressDisplay(progress, 'docker');
        if (progress.stage === 'finished') {
            eventSource.close();
            setTimeout(() => {
                hideUpdateProgress();
                progress.result.success ? showSuccess(progress.result.message) : showError(progress.result.message);
                loadDockerProjects(); loadDockerHosts(); loadLogs(); loadDashboard();
            }, 2000);
        }
    };
    eventSource.onerror = () => { eventSource.close(); hideUpdateProgress(); showError('Update stream failed'); };

    try { await fetch(`/api/docker/projects/${projectId}/update`, { method: 'POST' }); }
    catch (err) { eventSource.close(); hideUpdateProgress(); showError(err.message); }
}

// ── Docker Groups ─────────────────────────────────────────────────────────────
async function loadDockerGroups() {
    try {
        const res = await fetch('/api/docker/groups');
        dockerGroups = await res.json();
        displayDockerGroups(); loadDockerGroupsForSelect();
    } catch { showError('Failed to load Docker groups'); }
}

function displayDockerGroups() {
    const el = document.getElementById('docker-groups-list');
    if (!dockerGroups.length) {
        el.innerHTML = '<div class="col-span-full text-center py-12 text-slate-400">No Docker groups configured yet.</div>';
        return;
    }
    el.innerHTML = dockerGroups.map(g => {
        const schedule = g.auto_update_interval
            ? `Every ${escapeHtml(String(g.auto_update_interval))} ${escapeHtml(g.auto_update_interval_unit)}`
            : 'No schedule';
        const members = dockerHosts.filter(h => h.group_id === g.id);
        const membersHtml = members.length
            ? `<div class="mt-3 mb-4">
                <p class="text-xs text-slate-500 uppercase tracking-wide mb-2">Members (${members.length})</p>
                <div class="space-y-1">
                    ${members.map(h => `<div class="flex items-center justify-between text-sm px-2 py-1 bg-slate-700/50 rounded-lg">
                        <span class="text-slate-200 font-medium">${escapeHtml(h.name)}</span>
                        <span class="text-slate-400 font-mono text-xs">${escapeHtml(h.ip_address)}</span>
                    </div>`).join('')}
                </div>
            </div>`
            : `<p class="text-xs text-slate-500 mt-3 mb-4 italic">No hosts in this group</p>`;
        return `
            <div class="bg-slate-800/50 backdrop-blur-sm border border-slate-700/50 rounded-xl p-5 hover:border-slate-600 transition-all">
                <h3 class="text-lg font-semibold text-white mb-2">${escapeHtml(g.name)}</h3>
                <div class="space-y-1 mb-2 text-sm">
                    ${g.description ? `<p class="text-slate-300">${escapeHtml(g.description)}</p>` : ''}
                    <p class="text-slate-300"><span class="text-slate-400">Schedule:</span> ${schedule}</p>
                    ${g.auto_update_start_date ? `<p class="text-slate-300"><span class="text-slate-400">From:</span> ${new Date(g.auto_update_start_date).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' })}</p>` : ''}
                </div>
                ${membersHtml}
                <div class="grid grid-cols-3 gap-2">
                    <button onclick="editDockerGroup(${g.id})" class="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg text-sm font-medium transition-all">Edit</button>
                    <button onclick="updateDockerGroupWithProgress(${g.id})" class="px-3 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white rounded-lg text-sm font-medium transition-all">Update All</button>
                    <button onclick="deleteDockerGroup(${g.id})" class="px-3 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 text-slate-200 rounded-lg text-sm font-medium transition-all">Delete</button>
                </div>
            </div>`;
    }).join('');
}

// Fix #10: use in-memory dockerGroups instead of re-fetching
function loadDockerGroupsForSelect() {
    ['docker-host-group', 'edit-docker-group'].forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        const current = sel.value;
        sel.innerHTML = '<option value="">No group</option>' +
            dockerGroups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
        if (current) sel.value = current;
    });
}

async function refreshDockerGroups() {
    try { await loadDockerGroups(); showSuccess('Docker groups refreshed'); }
    catch { showError('Failed to refresh Docker groups'); }
}

async function handleAddDockerGroup(e) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    if (data.auto_update_start_date) data.auto_update_start_date = new Date(data.auto_update_start_date).toISOString();
    try {
        const res = await fetch('/api/docker/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (res.ok) { showSuccess('Docker group created!'); e.target.reset(); closeAddDockerGroupModal(); await loadDockerGroups(); }
        else { const err = await res.json(); showError(err.error || 'Failed to create Docker group'); }
    } catch { showError('Failed to create Docker group'); }
}

async function updateDockerGroupWithProgress(groupId) {
    const group = dockerGroups.find(g => g.id === groupId);
    if (!confirm(`Update all hosts in group "${escapeHtml(group?.name || groupId)}"?`)) return;
    showUpdateProgress(`Docker Group: ${escapeHtml(group?.name || groupId)}`);

    const eventSource = new EventSource(`/api/docker/groups/${groupId}/update-stream`);
    eventSource.onmessage = e => {
        const progress = JSON.parse(e.data);
        if (progress.stage === 'host_start') {
            const inner = JSON.parse(progress.message);
            document.getElementById('progress-title').textContent = `Updating host: ${escapeHtml(inner.name)}`;
        } else if (progress.stage === 'host_progress') {
            const inner = JSON.parse(progress.message);
            if (inner.stage === 'project_progress') {
                const proj = JSON.parse(inner.message);
                updateProgressDisplay(proj, 'docker');
            }
        } else if (progress.stage === 'finished') {
            eventSource.close();
            setTimeout(() => {
                hideUpdateProgress();
                const count = (progress.results || []).filter(r => r.success).length;
                showSuccess(`Updated ${count} of ${(progress.results || []).length} project(s)`);
                loadDockerHosts(); loadDockerProjects(); loadLogs(); loadDashboard();
            }, 2000);
        }
    };
    eventSource.onerror = () => { eventSource.close(); hideUpdateProgress(); showError('Group update stream failed'); };

    try { await fetch(`/api/docker/groups/${groupId}/update`, { method: 'POST' }); }
    catch (err) { eventSource.close(); hideUpdateProgress(); showError(err.message); }
}

async function editDockerGroup(id) {
    try {
        const res = await fetch(`/api/docker/groups/${id}`);
        const g = await res.json();
        document.getElementById('edit-docker-group-id').value = g.id;
        document.getElementById('edit-docker-group-name').value = g.name;
        document.getElementById('edit-docker-group-description').value = g.description || '';
        document.getElementById('edit-docker-group-interval').value = g.auto_update_interval || '';
        document.getElementById('edit-docker-group-interval-unit').value = g.auto_update_interval_unit || 'hours';
        if (g.auto_update_start_date) {
            const d = new Date(g.auto_update_start_date);
            document.getElementById('edit-docker-group-start-date').value =
                `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        } else { document.getElementById('edit-docker-group-start-date').value = ''; }
        const modal = document.getElementById('edit-docker-group-modal');
        modal.classList.remove('hidden'); modal.classList.add('flex');
    } catch { showError('Failed to load Docker group details'); }
}

function closeEditDockerGroupModal() {
    const modal = document.getElementById('edit-docker-group-modal');
    modal.classList.add('hidden'); modal.classList.remove('flex');
    document.getElementById('edit-docker-group-form').reset();
}

async function handleEditDockerGroup(e) {
    e.preventDefault();
    const formData = new FormData(e.target);
    const groupId = formData.get('id');
    const data = Object.fromEntries(formData);
    if (!data.auto_update_interval) { delete data.auto_update_interval; delete data.auto_update_interval_unit; delete data.auto_update_start_date; }
    else if (data.auto_update_start_date) data.auto_update_start_date = new Date(data.auto_update_start_date).toISOString();
    try {
        const res = await fetch(`/api/docker/groups/${groupId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (res.ok) { showSuccess('Docker group updated!'); closeEditDockerGroupModal(); await loadDockerGroups(); }
        else { const err = await res.json(); showError(err.error || 'Failed to update Docker group'); }
    } catch { showError('Failed to update Docker group'); }
}

async function deleteDockerGroup(groupId) {
    const g = dockerGroups.find(x => x.id === groupId);
    if (!confirm(`Delete Docker group "${escapeHtml(g?.name || groupId)}"?`)) return;
    try {
        const res = await fetch(`/api/docker/groups/${groupId}`, { method: 'DELETE' });
        if (res.ok) { showSuccess('Docker group deleted'); await loadDockerGroups(); }
        else { const err = await res.json(); showError(err.error || 'Failed to delete Docker group'); }
    } catch { showError('Failed to delete Docker group'); }
}

// ── Logs ──────────────────────────────────────────────────────────────────────
let currentLogsPage = 0;
const logsPerPage = 50;
let totalLogs = 0;

async function loadLogs() {
    try {
        const entityType = document.getElementById('filter-entity-type').value;
        const updateType = document.getElementById('filter-update-type').value;
        let url = `/api/logs?limit=${logsPerPage}&offset=${currentLogsPage * logsPerPage}`;
        if (entityType) url += `&entity_type=${entityType}`;
        if (updateType) url += `&update_type=${updateType}`;

        const data = await fetch(url).then(r => r.json());
        totalLogs = data.total;
        displayLogs(data.logs);
        updateLogsPagination();
    } catch { showError('Failed to load logs'); }
}

function displayLogs(logs) {
    const tbody = document.getElementById('logs-table-body');
    if (!logs.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-8 text-center text-slate-400">No logs found.</td></tr>`;
        return;
    }
    tbody.innerHTML = logs.map(log => {
        const ts = parseDbDate(log.timestamp).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });
        const icon = log.entity_type === 'docker' ? '🐳' : '🖥️';
        const badge = log.update_type === 'automatic'
            ? '<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-cyan-900/50 text-cyan-300 border border-cyan-700">Auto</span>'
            : '<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-900/50 text-blue-300 border border-blue-700">Manual</span>';
        const statusCls = log.success ? 'text-green-400' : 'text-red-400';

        let detailsRow = '';
        if (log.details) {
            try {
                const d = JSON.parse(log.details);
                if (log.entity_type === 'docker') {
                    const imgs = d.imagesUpdated?.length ? `<div class="mb-3"><div class="text-xs font-semibold text-cyan-400 mb-1">Images (${d.imagesUpdated.length}):</div><ul class="list-disc list-inside text-xs text-slate-300 space-y-1 ml-2">${d.imagesUpdated.map(i => `<li class="font-mono">${escapeHtml(i)}</li>`).join('')}</ul></div>` : '';
                    const ctrs = d.containersRecreated?.length ? `<div class="mb-3"><div class="text-xs font-semibold text-blue-400 mb-1">Containers (${d.containersRecreated.length}):</div><ul class="list-disc list-inside text-xs text-slate-300 space-y-1 ml-2">${d.containersRecreated.map(c => `<li class="font-mono">${escapeHtml(c)}</li>`).join('')}</ul></div>` : '';
                    const pullOut = d.pullOutput ? `<details class="mt-2"><summary class="text-xs font-semibold text-slate-400 cursor-pointer hover:text-slate-300">Pull Output</summary><pre class="mt-2 text-xs text-slate-300 bg-slate-900 p-3 rounded overflow-x-auto">${escapeHtml(d.pullOutput)}</pre></details>` : '';
                    const upOut = d.upOutput ? `<details class="mt-2"><summary class="text-xs font-semibold text-slate-400 cursor-pointer hover:text-slate-300">Up Output</summary><pre class="mt-2 text-xs text-slate-300 bg-slate-900 p-3 rounded overflow-x-auto">${escapeHtml(d.upOutput)}</pre></details>` : '';
                    detailsRow = `<tr id="details-${log.id}" class="hidden bg-slate-900/50"><td colspan="7" class="px-6 py-4"><div class="bg-slate-800/50 rounded-lg p-4 border border-slate-700"><div class="text-sm font-semibold text-white mb-3">Update Details</div>${imgs}${ctrs}${pullOut}${upOut}</div></td></tr>`;
                } else {
                    const reboot = d.needsReboot ? '<div class="text-xs text-yellow-400 mb-2">⚠️ Reboot recommended</div>' : '';
                    const pkgs = d.packagesUpgraded?.length ? `<div class="mb-3"><div class="text-xs font-semibold text-green-400 mb-1">Packages (${d.packagesUpgraded.length}):</div><div class="grid grid-cols-2 md:grid-cols-4 gap-1">${d.packagesUpgraded.map(p => `<div class="text-xs text-slate-300 font-mono bg-slate-900/50 px-2 py-1 rounded">${escapeHtml(p)}</div>`).join('')}</div></div>` : '<div class="text-xs text-slate-400 mb-2">No packages upgraded</div>';
                    const updOut = d.updateOutput ? `<details class="mt-2"><summary class="text-xs font-semibold text-slate-400 cursor-pointer">apt-get update output</summary><pre class="mt-2 text-xs text-slate-300 bg-slate-900 p-3 rounded overflow-x-auto">${escapeHtml(d.updateOutput)}</pre></details>` : '';
                    const upgOut = d.upgradeOutput ? `<details class="mt-2"><summary class="text-xs font-semibold text-slate-400 cursor-pointer">apt-get upgrade output</summary><pre class="mt-2 text-xs text-slate-300 bg-slate-900 p-3 rounded overflow-x-auto">${escapeHtml(d.upgradeOutput)}</pre></details>` : '';
                    const rmOut = d.autoremoveOutput ? `<details class="mt-2"><summary class="text-xs font-semibold text-slate-400 cursor-pointer">apt-get autoremove output</summary><pre class="mt-2 text-xs text-slate-300 bg-slate-900 p-3 rounded overflow-x-auto">${escapeHtml(d.autoremoveOutput)}</pre></details>` : '';
                    detailsRow = `<tr id="details-${log.id}" class="hidden bg-slate-900/50"><td colspan="7" class="px-6 py-4"><div class="bg-slate-800/50 rounded-lg p-4 border border-slate-700"><div class="text-sm font-semibold text-white mb-3">Update Details</div>${reboot}${pkgs}${updOut}${upgOut}${rmOut}</div></td></tr>`;
                }
            } catch {}
        }

        return `
            <tr class="hover:bg-slate-800/50 transition-colors border-b border-slate-700">
                <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-300">${ts}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-slate-300">${icon} ${escapeHtml(log.entity_type)}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-white">${escapeHtml(log.entity_name)}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm">${badge}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm ${statusCls} font-medium">${log.success ? '✓ Success' : '✗ Failed'}</td>
                <td class="px-6 py-4 text-sm text-slate-300">${escapeHtml(log.message)}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm">
                    ${log.details ? `<button onclick="toggleLogDetails(${log.id})" class="text-blue-400 hover:text-blue-300 text-xs font-medium"><span id="toggle-text-${log.id}">Show</span></button>` : '<span class="text-slate-500 text-xs">—</span>'}
                </td>
            </tr>${detailsRow}`;
    }).join('');
}

function toggleLogDetails(logId) {
    const row = document.getElementById(`details-${logId}`);
    const txt = document.getElementById(`toggle-text-${logId}`);
    if (!row) return;
    const hidden = row.classList.toggle('hidden');
    if (txt) txt.textContent = hidden ? 'Show' : 'Hide';
}

function updateLogsPagination() {
    const start = currentLogsPage * logsPerPage + 1;
    const end = Math.min((currentLogsPage + 1) * logsPerPage, totalLogs);
    document.getElementById('logs-count').textContent = `Showing ${start}–${end} of ${totalLogs}`;
    document.getElementById('logs-prev-btn').disabled = currentLogsPage === 0;
    document.getElementById('logs-next-btn').disabled = end >= totalLogs;
}

function previousLogsPage() { if (currentLogsPage > 0) { currentLogsPage--; loadLogs(); } }
function nextLogsPage() { if ((currentLogsPage + 1) * logsPerPage < totalLogs) { currentLogsPage++; loadLogs(); } }

// ── Credentials ───────────────────────────────────────────────────────────────
let credentials = [];

async function loadCredentials() {
    try {
        const res = await fetch('/api/credentials');
        credentials = await res.json();
        displayCredentials();
        populateCredentialPickers();
    } catch { showError('Failed to load credentials'); }
}

function displayCredentials() {
    const el = document.getElementById('credentials-list');
    if (!el) return;
    if (!credentials.length) {
        el.innerHTML = '<div class="col-span-full text-center py-12 text-slate-400">No credentials saved yet. Add your first credential!</div>';
        return;
    }
    el.innerHTML = credentials.map(c => {
        const authIcon = c.auth_type === 'ssh_key' ? '🔑' : '🔐';
        const authLabel = c.auth_type === 'ssh_key' ? 'SSH Key' : 'Password';
        const ts = parseDbDate(c.created_at).toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam' });
        return `
        <div class="bg-slate-800/50 backdrop-blur-sm border border-slate-700/50 rounded-xl p-5 hover:border-slate-600 transition-all duration-200">
            <div class="flex items-start justify-between mb-3">
                <div>
                    <h3 class="text-base font-semibold text-white">${escapeHtml(c.name)}</h3>
                    <p class="text-sm text-slate-400 mt-0.5">${escapeHtml(c.username)}</p>
                </div>
                <span class="text-lg" title="${authLabel}">${authIcon}</span>
            </div>
            <div class="flex items-center gap-2 mb-4">
                <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-700 text-slate-300">${authLabel}</span>
                <span class="text-xs text-slate-500">Added ${ts}</span>
            </div>
            <button onclick="deleteCredential(${c.id})" class="w-full px-3 py-2 bg-slate-700 hover:bg-red-900/40 border border-slate-600 hover:border-red-700 text-slate-300 hover:text-red-300 rounded-lg text-sm font-medium transition-all">Delete</button>
        </div>`;
    }).join('');
}

function populateCredentialPickers() {
    const pickerIds = ['server-credential', 'docker-credential', 'edit-server-credential', 'edit-docker-credential'];
    pickerIds.forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        const currentVal = sel.value;
        sel.innerHTML = '<option value="">— Enter credentials manually —</option>' +
            credentials.map(c => {
                const label = c.auth_type === 'ssh_key' ? '🔑' : '🔐';
                return `<option value="${c.id}">${label} ${escapeHtml(c.name)} (${escapeHtml(c.username)})</option>`;
            }).join('');
        if (currentVal) sel.value = currentVal;
    });
}

function applyCredentialToForm(select, formId) {
    const credId = parseInt(select.value) || null;
    const cred = credId ? credentials.find(c => c.id === credId) : null;

    const map = {
        'add-server':   { username: 'server-username',       authType: 'auth-type',         pwdField: 'password-field',       keyField: 'ssh-key-field',       info: 'server-credential-info',       prefix: '' },
        'add-docker':   { username: 'docker-host-username',  authType: 'docker-auth-type',  pwdField: 'docker-password-field', keyField: 'docker-ssh-key-field', info: 'docker-credential-info',       prefix: 'docker' },
        'edit-server':  { username: 'edit-server-username',  authType: 'edit-auth-type',    pwdField: 'edit-password-field',   keyField: 'edit-ssh-key-field',   info: 'edit-server-credential-info',  prefix: 'edit' },
        'edit-docker':  { username: 'edit-docker-host-username', authType: 'edit-docker-auth-type', pwdField: 'edit-docker-password-field', keyField: 'edit-docker-ssh-key-field', info: 'edit-docker-credential-info', prefix: 'edit-docker' }
    };

    const ids = map[formId];
    if (!ids) return;

    const usernameEl = document.getElementById(ids.username);
    const authTypeEl = document.getElementById(ids.authType);
    const pwdField   = document.getElementById(ids.pwdField);
    const keyField   = document.getElementById(ids.keyField);
    const infoEl     = document.getElementById(ids.info);

    if (!cred) {
        if (usernameEl) usernameEl.readOnly = false;
        if (authTypeEl) { authTypeEl.style.pointerEvents = ''; authTypeEl.style.opacity = ''; }
        if (infoEl)     { infoEl.classList.add('hidden'); infoEl.innerHTML = ''; }
        toggleAuthFields(ids.prefix);
        return;
    }

    if (usernameEl) { usernameEl.value = cred.username; usernameEl.readOnly = true; }
    // Keep auth_type enabled so FormData includes it; visually lock it instead of disabling
    if (authTypeEl) { authTypeEl.value = cred.auth_type; authTypeEl.style.pointerEvents = 'none'; authTypeEl.style.opacity = '0.5'; }
    // Hide fields AND remove required so browser validation doesn't block submission
    if (pwdField) {
        pwdField.classList.add('hidden');
        const inp = pwdField.querySelector('input');
        if (inp) inp.required = false;
    }
    if (keyField) {
        keyField.classList.add('hidden');
        const inp = keyField.querySelector('input');
        if (inp) inp.required = false;
    }
    if (infoEl) {
        const authLabel = cred.auth_type === 'ssh_key' ? '🔑 SSH Key' : '🔐 Password';
        infoEl.innerHTML = `Using saved credential "<strong>${escapeHtml(cred.name)}</strong>" — ${escapeHtml(cred.username)}, ${authLabel}`;
        infoEl.classList.remove('hidden');
    }
}

function toggleCredAuthFields() {
    const type = document.getElementById('cred-auth-type').value;
    document.getElementById('cred-password-field').classList.toggle('hidden', type !== 'password');
    document.getElementById('cred-ssh-key-field').classList.toggle('hidden', type !== 'ssh_key');
    const pwdInput = document.getElementById('cred-password');
    const keyInput = document.getElementById('cred-ssh-key');
    if (pwdInput) pwdInput.required = type === 'password';
    if (keyInput) keyInput.required = type === 'ssh_key';
}

async function handleAddCredential(e) {
    e.preventDefault();
    try {
        const res = await fetch('/api/credentials', { method: 'POST', body: new FormData(e.target) });
        if (res.ok) {
            showSuccess('Credential saved!');
            e.target.reset();
            toggleCredAuthFields();
            await loadCredentials();
            closeAddCredentialModal();
        } else {
            const err = await res.json();
            showError(err.error || 'Failed to save credential');
        }
    } catch { showError('Failed to save credential'); }
}

async function deleteCredential(id) {
    const cred = credentials.find(c => c.id === id);
    if (!confirm(`Delete credential "${escapeHtml(cred?.name || id)}"? Servers using it will lose access.`)) return;
    try {
        const res = await fetch(`/api/credentials/${id}`, { method: 'DELETE' });
        if (res.ok) { showSuccess('Credential deleted'); await loadCredentials(); }
        else { const err = await res.json(); showError(err.error || 'Failed to delete credential'); }
    } catch { showError('Failed to delete credential'); }
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

let webhooks = [];

async function loadWebhooks() {
    try {
        const res = await fetch('/api/webhooks');
        webhooks = await res.json();
        displayWebhooks();
    } catch { /* silent */ }
}

function displayWebhooks() {
    const el = document.getElementById('webhooks-list');
    if (!el) return;
    if (!webhooks.length) {
        el.innerHTML = '<div class="col-span-3 text-center py-12 text-slate-400">No webhooks configured yet. <button onclick="openAddWebhookModal()" class="text-blue-400 hover:underline">Add one</button>.</div>';
        return;
    }
    el.innerHTML = webhooks.map(wh => `
        <div class="bg-slate-800/50 backdrop-blur-sm border border-slate-700/50 rounded-xl p-5 space-y-3">
            <div class="flex items-start justify-between gap-2">
                <div>
                    <h3 class="font-semibold text-white">${escapeHtml(wh.name)}</h3>
                    <p class="text-xs text-slate-400 mt-0.5 break-all">${escapeHtml(wh.url.replace(/\/[^/]+$/, '/***'))}</p>
                </div>
                <span class="shrink-0 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${wh.enabled ? 'bg-green-900/50 text-green-300 border border-green-700/50' : 'bg-slate-700 text-slate-400 border border-slate-600'}">
                    ${wh.enabled ? 'Enabled' : 'Disabled'}
                </span>
            </div>
            <div class="flex gap-3 text-xs text-slate-400">
                <span class="${wh.notify_success ? 'text-green-400' : 'line-through'}">✅ Success</span>
                <span class="${wh.notify_failure ? 'text-red-400' : 'line-through'}">❌ Failure</span>
            </div>
            <div class="flex flex-wrap gap-2 pt-1">
                <button onclick="testWebhook(${wh.id})" class="px-3 py-1.5 bg-indigo-600/80 hover:bg-indigo-600 text-white text-xs rounded-lg transition-colors">
                    Test
                </button>
                <button onclick="toggleWebhook(${wh.id}, ${wh.enabled})" class="px-3 py-1.5 ${wh.enabled ? 'bg-amber-600/80 hover:bg-amber-600' : 'bg-green-600/80 hover:bg-green-600'} text-white text-xs rounded-lg transition-colors">
                    ${wh.enabled ? 'Disable' : 'Enable'}
                </button>
                <button onclick="deleteWebhook(${wh.id})" class="px-3 py-1.5 bg-red-600/80 hover:bg-red-600 text-white text-xs rounded-lg transition-colors">
                    Delete
                </button>
            </div>
        </div>
    `).join('');
}

async function handleAddWebhook(e) {
    e.preventDefault();
    const body = {
        name: document.getElementById('webhook-name').value,
        url: document.getElementById('webhook-url').value,
        notify_success: document.getElementById('webhook-notify-success').checked ? 1 : 0,
        notify_failure: document.getElementById('webhook-notify-failure').checked ? 1 : 0
    };
    try {
        const res = await fetch('/api/webhooks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (res.ok) {
            showSuccess('Webhook saved!');
            e.target.reset();
            await loadWebhooks();
            closeAddWebhookModal();
        } else {
            const err = await res.json();
            showError(err.error || 'Failed to save webhook');
        }
    } catch { showError('Failed to save webhook'); }
}

async function testWebhook(id) {
    try {
        const res = await fetch(`/api/webhooks/${id}/test`, { method: 'POST' });
        if (res.ok) showSuccess('Test notification sent to Discord!');
        else { const err = await res.json(); showError(err.error || 'Test failed'); }
    } catch { showError('Test failed'); }
}

async function toggleWebhook(id, currentEnabled) {
    try {
        const res = await fetch(`/api/webhooks/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: currentEnabled ? 0 : 1 })
        });
        if (res.ok) { await loadWebhooks(); }
        else { const err = await res.json(); showError(err.error || 'Failed to update webhook'); }
    } catch { showError('Failed to update webhook'); }
}

async function deleteWebhook(id) {
    const wh = webhooks.find(w => w.id === id);
    if (!confirm(`Delete webhook "${escapeHtml(wh?.name || id)}"?`)) return;
    try {
        const res = await fetch(`/api/webhooks/${id}`, { method: 'DELETE' });
        if (res.ok) { showSuccess('Webhook deleted'); await loadWebhooks(); }
        else { const err = await res.json(); showError(err.error || 'Failed to delete webhook'); }
    } catch { showError('Failed to delete webhook'); }
}

// ── Add modals ────────────────────────────────────────────────────────────────

function openAddServerModal() {
    document.getElementById('add-server-form').reset();
    const m = document.getElementById('add-server-modal');
    m.classList.remove('hidden');
    m.classList.add('flex');
}
function closeAddServerModal() {
    const m = document.getElementById('add-server-modal');
    m.classList.add('hidden');
    m.classList.remove('flex');
}

function openAddGroupModal() {
    document.getElementById('add-group-form').reset();
    const m = document.getElementById('add-group-modal');
    m.classList.remove('hidden');
    m.classList.add('flex');
}
function closeAddGroupModal() {
    const m = document.getElementById('add-group-modal');
    m.classList.add('hidden');
    m.classList.remove('flex');
}

function openAddDockerHostModal() {
    document.getElementById('add-docker-host-form').reset();
    const m = document.getElementById('add-docker-host-modal');
    m.classList.remove('hidden');
    m.classList.add('flex');
}
function closeAddDockerHostModal() {
    const m = document.getElementById('add-docker-host-modal');
    m.classList.add('hidden');
    m.classList.remove('flex');
}

function openAddDockerGroupModal() {
    document.getElementById('add-docker-group-form').reset();
    const m = document.getElementById('add-docker-group-modal');
    m.classList.remove('hidden');
    m.classList.add('flex');
}
function closeAddDockerGroupModal() {
    const m = document.getElementById('add-docker-group-modal');
    m.classList.add('hidden');
    m.classList.remove('flex');
}

function openAddCredentialModal() {
    document.getElementById('add-credential-form').reset();
    toggleCredAuthFields();
    const m = document.getElementById('add-credential-modal');
    m.classList.remove('hidden'); m.classList.add('flex');
}
function closeAddCredentialModal() {
    const m = document.getElementById('add-credential-modal');
    m.classList.add('hidden'); m.classList.remove('flex');
}

function openAddWebhookModal() {
    document.getElementById('add-webhook-form').reset();
    const m = document.getElementById('add-webhook-modal');
    m.classList.remove('hidden'); m.classList.add('flex');
}
function closeAddWebhookModal() {
    const m = document.getElementById('add-webhook-modal');
    m.classList.add('hidden'); m.classList.remove('flex');
}

// ── NetBox Import ─────────────────────────────────────────────────────────────

let netboxVMs = [];

async function openNetboxImportModal() {
    netboxVMs = [];
    document.getElementById('netbox-vm-list').classList.add('hidden');
    document.getElementById('netbox-options').classList.add('hidden');
    document.getElementById('netbox-result').classList.add('hidden');
    document.getElementById('netbox-import-btn').disabled = true;
    document.getElementById('netbox-fetch-status').textContent = '';
    document.getElementById('netbox-vm-table').innerHTML = '';
    document.getElementById('netbox-select-all').checked = false;
    document.getElementById('netbox-port').value = '22';
    document.getElementById('netbox-sudo').value = '';
    // Populate credentials dropdown
    const credSel = document.getElementById('netbox-credential');
    credSel.innerHTML = '<option value="">— Select a saved credential —</option>';
    try {
        const res = await fetch('/api/credentials');
        const creds = await res.json();
        creds.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = `${escapeHtml(c.name)} (${escapeHtml(c.username)} / ${c.auth_type})`;
            credSel.appendChild(opt);
        });
    } catch {}

    // Populate groups dropdown
    const groupSel = document.getElementById('netbox-group');
    groupSel.innerHTML = '<option value="">— No group —</option>';
    try {
        const res = await fetch('/api/groups');
        const grps = await res.json();
        grps.forEach(g => {
            const opt = document.createElement('option');
            opt.value = g.id;
            opt.textContent = escapeHtml(g.name);
            groupSel.appendChild(opt);
        });
    } catch {}

    document.getElementById('netbox-import-modal').classList.remove('hidden');
}

function closeNetboxImportModal() {
    document.getElementById('netbox-import-modal').classList.add('hidden');
}

async function fetchNetboxVMs() {
    const btn = document.getElementById('netbox-fetch-btn');
    const status = document.getElementById('netbox-fetch-status');
    btn.disabled = true;
    status.textContent = 'Fetching…';

    try {
        const res = await fetch('/api/netbox/vms');
        const data = await res.json();

        if (!res.ok) {
            status.textContent = '';
            showError(data.error || 'Failed to fetch VMs from NetBox');
            btn.disabled = false;
            return;
        }

        if (!data.configured) {
            status.textContent = '';
            document.getElementById('netbox-vm-list').classList.remove('hidden');
            document.getElementById('netbox-vm-table').innerHTML = `
                <div class="p-4 text-sm text-amber-400 bg-amber-900/20 border border-amber-700/40 rounded-lg">
                    NetBox is not configured. Add <code class="bg-slate-700 px-1 rounded">NETBOX_URL</code> and
                    <code class="bg-slate-700 px-1 rounded">NETBOX_TOKEN</code> environment variables and restart the container.
                </div>`;
            btn.disabled = false;
            return;
        }

        netboxVMs = data.vms;
        status.textContent = `${data.vms.length} VM(s) found`;

        renderNetboxVMTable(data.vms);
        document.getElementById('netbox-vm-list').classList.remove('hidden');
        document.getElementById('netbox-options').classList.remove('hidden');
        updateNetboxImportBtn();
    } catch (err) {
        status.textContent = '';
        showError('Failed to fetch VMs: ' + err.message);
    }

    btn.disabled = false;
}

function renderNetboxVMTable(vms) {
    const table = document.getElementById('netbox-vm-table');
    if (vms.length === 0) {
        table.innerHTML = '<div class="p-4 text-sm text-slate-400 text-center">No VMs found with the <code class="bg-slate-700 px-1 rounded text-indigo-300">update-manager</code> tag.</div>';
        return;
    }

    const rows = vms.map(vm => {
        const disabled = vm.alreadyExists ? 'disabled' : '';
        const rowClass = vm.alreadyExists ? 'opacity-40' : 'hover:bg-slate-700/30';
        const badge = vm.alreadyExists
            ? '<span class="text-xs text-slate-500 italic">already imported</span>'
            : '';
        const cluster = vm.cluster ? escapeHtml(vm.cluster) : '<span class="text-slate-500">—</span>';
        return `
            <div class="flex items-center gap-4 px-4 py-3 border-b border-slate-700/50 last:border-0 ${rowClass}">
                <input type="checkbox" data-vm-id="${vm.id}" class="netbox-vm-check rounded border-slate-600 bg-slate-900 text-indigo-500 focus:ring-indigo-500" ${disabled} ${vm.alreadyExists ? '' : ''} onchange="updateNetboxImportBtn()">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <span class="text-sm font-medium text-white truncate">${escapeHtml(vm.name)}</span>
                        ${badge}
                    </div>
                    <div class="text-xs text-slate-400">${escapeHtml(vm.ip)} &nbsp;·&nbsp; ${cluster}</div>
                </div>
            </div>`;
    }).join('');

    table.innerHTML = rows;
}

function netboxToggleAll(checked) {
    document.querySelectorAll('.netbox-vm-check:not(:disabled)').forEach(cb => { cb.checked = checked; });
    updateNetboxImportBtn();
}

function updateNetboxImportBtn() {
    const anyChecked = [...document.querySelectorAll('.netbox-vm-check:not(:disabled)')].some(cb => cb.checked);
    document.getElementById('netbox-import-btn').disabled = !anyChecked;
}

async function importNetboxVMs() {
    const checkedIds = [...document.querySelectorAll('.netbox-vm-check:not(:disabled):checked')]
        .map(cb => parseInt(cb.dataset.vmId));

    if (checkedIds.length === 0) return;

    const credential_id = document.getElementById('netbox-credential').value;
    if (!credential_id) { showError('Please select a credential before importing'); return; }

    const btn = document.getElementById('netbox-import-btn');
    btn.disabled = true;
    btn.textContent = 'Importing…';

    const body = {
        vmIds: checkedIds,
        credential_id: parseInt(credential_id),
        group_id: document.getElementById('netbox-group').value || null,
        port: parseInt(document.getElementById('netbox-port').value) || 22,
        sudo_password: document.getElementById('netbox-sudo').value || null
    };

    try {
        const res = await fetch('/api/netbox/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();

        if (!res.ok) { showError(data.error || 'Import failed'); btn.disabled = false; btn.textContent = 'Import Selected'; return; }

        const resultEl = document.getElementById('netbox-result');
        resultEl.classList.remove('hidden');

        let html = '';
        if (data.imported.length > 0) {
            html += `<div class="p-3 bg-green-900/20 border border-green-700/40 rounded-lg mb-3">
                <p class="text-sm font-medium text-green-400 mb-1">✅ Imported ${data.imported.length} server(s)</p>
                <ul class="text-xs text-green-300 space-y-0.5">${data.imported.map(s => `<li>${escapeHtml(s.name)} (${escapeHtml(s.ip)})</li>`).join('')}</ul>
            </div>`;
        }
        if (data.skipped.length > 0) {
            html += `<div class="p-3 bg-slate-700/50 border border-slate-600/40 rounded-lg">
                <p class="text-sm font-medium text-slate-300 mb-1">Skipped ${data.skipped.length} item(s)</p>
                <ul class="text-xs text-slate-400 space-y-0.5">${data.skipped.map(s => `<li>${escapeHtml(s.name || s.id)} — ${escapeHtml(s.reason)}</li>`).join('')}</ul>
            </div>`;
        }
        resultEl.innerHTML = html;

        if (data.imported.length > 0) {
            closeNetboxImportModal();
            await loadServers();
            showSuccess(`${data.imported.length} server(s) imported from NetBox`);
        }
    } catch (err) {
        showError('Import failed: ' + err.message);
    }

    btn.disabled = false;
    btn.textContent = 'Import Selected';
}

// ── Docker Discovery ──────────────────────────────────────────────────────────
function showDiscoverModal(hostId = null) {
    const sel = document.getElementById('discover-host');
    sel.innerHTML = '<option value="">Select a host...</option>' +
        dockerHosts.map(h => `<option value="${h.id}" ${h.id === hostId ? 'selected' : ''}>${escapeHtml(h.name)}</option>`).join('');
    document.getElementById('discover-results').classList.add('hidden');
    document.getElementById('discover-results').innerHTML = '';
    const modal = document.getElementById('discover-modal');
    modal.classList.remove('hidden'); modal.classList.add('flex');
}

function closeDiscoverModal() {
    const modal = document.getElementById('discover-modal');
    modal.classList.add('hidden'); modal.classList.remove('flex');
}

async function runDiscoveryScan() {
    const hostId = document.getElementById('discover-host').value;
    const rootPath = document.getElementById('discover-root-path').value.trim();
    const maxDepth = document.getElementById('discover-max-depth').value;

    if (!hostId) { showError('Please select a host'); return; }
    if (!rootPath) { showError('Please enter a root folder path'); return; }

    const btn = document.getElementById('discover-scan-btn');
    const spinner = document.getElementById('discover-spinner');
    btn.disabled = true;
    spinner.classList.remove('hidden');

    const resultsEl = document.getElementById('discover-results');
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';

    try {
        const res = await fetch(`/api/docker/hosts/${hostId}/discover`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ root_path: rootPath, max_depth: maxDepth })
        });
        const data = await res.json();
        if (!res.ok) { showError(data.error || 'Discovery failed'); return; }
        renderDiscoveryResults(data, parseInt(hostId));
    } catch (err) {
        showError('Discovery failed: ' + err.message);
    } finally {
        btn.disabled = false;
        spinner.classList.add('hidden');
    }
}

function renderDiscoveryResults({ found, alreadyRegistered }, hostId) {
    const el = document.getElementById('discover-results');
    let html = '';

    if (found.length === 0 && alreadyRegistered.length === 0) {
        html = '<p class="text-center text-slate-400 py-4">No docker-compose files found in that directory.</p>';
    } else {
        if (found.length > 0) {
            html += `
                <div>
                    <div class="flex items-center justify-between mb-3">
                        <h3 class="text-sm font-semibold text-slate-300">New Projects Found (${found.length})</h3>
                        <label class="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                            <input type="checkbox" id="disc-select-all" checked onchange="toggleSelectAllDiscovered(this)"
                                class="h-3.5 w-3.5 rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-blue-500">
                            Select all
                        </label>
                    </div>
                    <div class="space-y-3" id="discover-new-list">
                        ${found.map((p, i) => `
                            <div class="flex items-start gap-3 p-3 bg-slate-900/50 border border-slate-700 rounded-lg">
                                <input type="checkbox" id="disc-${i}" checked
                                    class="mt-2 h-4 w-4 rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-blue-500 flex-shrink-0"
                                    data-compose="${escapeHtml(p.composePath)}"
                                    data-workdir="${escapeHtml(p.workingDirectory)}">
                                <div class="flex-1 min-w-0">
                                    <input type="text" value="${escapeHtml(p.name)}" id="disc-name-${i}"
                                        class="block w-full px-2 py-1 mb-1 bg-slate-800 border border-slate-600 rounded text-sm font-medium text-white focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all">
                                    <p class="text-xs text-slate-400 truncate" title="${escapeHtml(p.composePath)}">${escapeHtml(p.composePath)}</p>
                                </div>
                            </div>`).join('')}
                    </div>
                    <button onclick="addDiscoveredProjects(${hostId})"
                        class="mt-4 w-full flex justify-center py-2.5 px-4 rounded-lg text-sm font-medium text-white bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 focus:outline-none focus:ring-2 focus:ring-green-500 transition-all">
                        Add Selected Projects
                    </button>
                </div>`;
        } else {
            html += '<p class="text-slate-400 text-sm py-2">No new projects found — all discovered projects are already registered.</p>';
        }

        if (alreadyRegistered.length > 0) {
            html += `
                <div class="mt-5 pt-5 border-t border-slate-700">
                    <h3 class="text-sm font-semibold text-slate-500 mb-3">Already Registered (${alreadyRegistered.length})</h3>
                    <div class="space-y-2">
                        ${alreadyRegistered.map(p => `
                            <div class="flex items-center gap-3 p-3 bg-slate-900/30 border border-slate-700/50 rounded-lg opacity-60">
                                <svg class="h-4 w-4 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
                                </svg>
                                <div class="min-w-0">
                                    <p class="text-sm text-slate-400 font-medium">${escapeHtml(p.name)}</p>
                                    <p class="text-xs text-slate-500 truncate" title="${escapeHtml(p.composePath)}">${escapeHtml(p.composePath)}</p>
                                </div>
                            </div>`).join('')}
                    </div>
                </div>`;
        }
    }

    el.innerHTML = html;
    el.classList.remove('hidden');
}

function toggleSelectAllDiscovered(cb) {
    document.querySelectorAll('#discover-new-list input[type="checkbox"]').forEach(c => c.checked = cb.checked);
}

async function addDiscoveredProjects(hostId) {
    const list = document.getElementById('discover-new-list');
    if (!list) return;

    const checkboxes = Array.from(list.querySelectorAll('input[type="checkbox"]:checked'));
    if (checkboxes.length === 0) { showError('No projects selected'); return; }

    const items = checkboxes.map(cb => {
        const i = cb.id.replace('disc-', '');
        return {
            host_id: hostId,
            name: (document.getElementById(`disc-name-${i}`)?.value || '').trim(),
            compose_file_path: cb.dataset.compose,
            working_directory: cb.dataset.workdir
        };
    });

    let added = 0, failed = 0;
    for (const item of items) {
        try {
            const res = await fetch('/api/docker/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item)
            });
            if (res.ok) added++;
            else failed++;
        } catch { failed++; }
    }

    if (added > 0) {
        showSuccess(`Added ${added} project${added !== 1 ? 's' : ''}${failed > 0 ? ` (${failed} failed)` : ''}`);
        closeDiscoverModal();
        await loadDockerProjects();
        await loadDockerHosts();
    } else {
        showError('Failed to add projects — check paths are valid');
    }
}

// ── NetBox Docker Host Import ──────────────────────────────────────────────────

let netboxDockerVMs = [];

async function openNetboxDockerImportModal() {
    netboxDockerVMs = [];
    document.getElementById('netbox-docker-vm-list').classList.add('hidden');
    document.getElementById('netbox-docker-options').classList.add('hidden');
    document.getElementById('netbox-docker-result').classList.add('hidden');
    document.getElementById('netbox-docker-import-btn').disabled = true;
    document.getElementById('netbox-docker-fetch-status').textContent = '';
    document.getElementById('netbox-docker-vm-table').innerHTML = '';
    document.getElementById('netbox-docker-select-all').checked = false;
    document.getElementById('netbox-docker-port').value = '22';
    document.getElementById('netbox-docker-sudo').value = '';

    const credSel = document.getElementById('netbox-docker-credential');
    credSel.innerHTML = '<option value="">— Select a saved credential —</option>';
    try {
        const res = await fetch('/api/credentials');
        const creds = await res.json();
        creds.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = `${escapeHtml(c.name)} (${escapeHtml(c.username)} / ${c.auth_type})`;
            credSel.appendChild(opt);
        });
    } catch {}

    const groupSel = document.getElementById('netbox-docker-group');
    groupSel.innerHTML = '<option value="">— No group —</option>';
    try {
        const res = await fetch('/api/docker/groups');
        const grps = await res.json();
        grps.forEach(g => {
            const opt = document.createElement('option');
            opt.value = g.id;
            opt.textContent = escapeHtml(g.name);
            groupSel.appendChild(opt);
        });
    } catch {}

    document.getElementById('netbox-docker-import-modal').classList.remove('hidden');
}

function closeNetboxDockerImportModal() {
    document.getElementById('netbox-docker-import-modal').classList.add('hidden');
}

async function fetchNetboxDockerVMs() {
    const btn = document.getElementById('netbox-docker-fetch-btn');
    const status = document.getElementById('netbox-docker-fetch-status');
    btn.disabled = true;
    status.textContent = 'Fetching…';

    try {
        const res = await fetch('/api/netbox/docker-vms');
        const data = await res.json();

        if (!res.ok) {
            status.textContent = '';
            showError(data.error || 'Failed to fetch VMs from NetBox');
            btn.disabled = false;
            return;
        }

        if (!data.configured) {
            status.textContent = '';
            document.getElementById('netbox-docker-vm-list').classList.remove('hidden');
            document.getElementById('netbox-docker-vm-table').innerHTML = `
                <div class="p-4 text-sm text-amber-400 bg-amber-900/20 border border-amber-700/40 rounded-lg">
                    NetBox is not configured. Add <code class="bg-slate-700 px-1 rounded">NETBOX_URL</code> and
                    <code class="bg-slate-700 px-1 rounded">NETBOX_TOKEN</code> environment variables and restart the container.
                </div>`;
            btn.disabled = false;
            return;
        }

        netboxDockerVMs = data.vms;
        status.textContent = `${data.vms.length} VM(s) found`;

        renderNetboxDockerVMTable(data.vms);
        document.getElementById('netbox-docker-vm-list').classList.remove('hidden');
        document.getElementById('netbox-docker-options').classList.remove('hidden');
        updateNetboxDockerImportBtn();
    } catch (err) {
        status.textContent = '';
        showError('Failed to fetch VMs: ' + err.message);
    }

    btn.disabled = false;
}

function renderNetboxDockerVMTable(vms) {
    const table = document.getElementById('netbox-docker-vm-table');
    if (vms.length === 0) {
        table.innerHTML = '<div class="p-4 text-sm text-slate-400 text-center">No VMs found with the <code class="bg-slate-700 px-1 rounded text-indigo-300">update-manager</code> tag.</div>';
        return;
    }

    const rows = vms.map(vm => {
        const disabled = vm.alreadyExists ? 'disabled' : '';
        const rowClass = vm.alreadyExists ? 'opacity-40' : 'hover:bg-slate-700/30';
        const badge = vm.alreadyExists
            ? '<span class="text-xs text-slate-500 italic">already imported</span>'
            : '';
        const cluster = vm.cluster ? escapeHtml(vm.cluster) : '<span class="text-slate-500">—</span>';
        return `
            <div class="flex items-center gap-4 px-4 py-3 border-b border-slate-700/50 last:border-0 ${rowClass}">
                <input type="checkbox" data-vm-id="${vm.id}" class="netbox-docker-vm-check rounded border-slate-600 bg-slate-900 text-indigo-500 focus:ring-indigo-500" ${disabled} onchange="updateNetboxDockerImportBtn()">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <span class="text-sm font-medium text-white truncate">${escapeHtml(vm.name)}</span>
                        ${badge}
                    </div>
                    <div class="text-xs text-slate-400">${escapeHtml(vm.ip)} &nbsp;·&nbsp; ${cluster}</div>
                </div>
            </div>`;
    }).join('');

    table.innerHTML = rows;
}

function netboxDockerToggleAll(checked) {
    document.querySelectorAll('.netbox-docker-vm-check:not(:disabled)').forEach(cb => { cb.checked = checked; });
    updateNetboxDockerImportBtn();
}

function updateNetboxDockerImportBtn() {
    const anyChecked = [...document.querySelectorAll('.netbox-docker-vm-check:not(:disabled)')].some(cb => cb.checked);
    document.getElementById('netbox-docker-import-btn').disabled = !anyChecked;
}

async function importNetboxDockerVMs() {
    const checkedIds = [...document.querySelectorAll('.netbox-docker-vm-check:not(:disabled):checked')]
        .map(cb => parseInt(cb.dataset.vmId));

    if (checkedIds.length === 0) return;

    const credential_id = document.getElementById('netbox-docker-credential').value;
    if (!credential_id) { showError('Please select a credential before importing'); return; }

    const btn = document.getElementById('netbox-docker-import-btn');
    btn.disabled = true;
    btn.textContent = 'Importing…';

    const body = {
        vmIds: checkedIds,
        credential_id: parseInt(credential_id),
        group_id: document.getElementById('netbox-docker-group').value || null,
        port: parseInt(document.getElementById('netbox-docker-port').value) || 22,
        sudo_password: document.getElementById('netbox-docker-sudo').value || null
    };

    try {
        const res = await fetch('/api/netbox/docker-import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();

        if (!res.ok) { showError(data.error || 'Import failed'); btn.disabled = false; btn.textContent = 'Import Selected'; return; }

        const resultEl = document.getElementById('netbox-docker-result');
        resultEl.classList.remove('hidden');

        let html = '';
        if (data.imported.length > 0) {
            html += `<div class="p-3 bg-green-900/20 border border-green-700/40 rounded-lg mb-3">
                <p class="text-sm font-medium text-green-400 mb-1">✅ Imported ${data.imported.length} docker host(s)</p>
                <ul class="text-xs text-green-300 space-y-0.5">${data.imported.map(s => `<li>${escapeHtml(s.name)} (${escapeHtml(s.ip)})</li>`).join('')}</ul>
            </div>`;
        }
        if (data.skipped.length > 0) {
            html += `<div class="p-3 bg-slate-700/50 border border-slate-600/40 rounded-lg">
                <p class="text-sm font-medium text-slate-300 mb-1">Skipped ${data.skipped.length} item(s)</p>
                <ul class="text-xs text-slate-400 space-y-0.5">${data.skipped.map(s => `<li>${escapeHtml(s.name || s.id)} — ${escapeHtml(s.reason)}</li>`).join('')}</ul>
            </div>`;
        }
        resultEl.innerHTML = html;

        if (data.imported.length > 0) {
            closeNetboxDockerImportModal();
            await loadDockerHosts();
            showSuccess(`${data.imported.length} docker host(s) imported from NetBox`);
        }
    } catch (err) {
        showError('Import failed: ' + err.message);
    }

    btn.disabled = false;
    btn.textContent = 'Import Selected';
}

// ── Activity stream (scheduled auto-updates) ──────────────────────────────────

let activityDismissed = false;
let activityHideTimer = null;

function initActivityStream() {
    const es = new EventSource('/api/activity-stream');
    es.onmessage = (e) => {
        try { handleActivityEvent(JSON.parse(e.data)); } catch {}
    };
    es.onerror = () => {
        es.close();
        setTimeout(initActivityStream, 5000);
    };
}

function handleActivityEvent(data) {
    const panel   = document.getElementById('activity-panel');
    const dot     = document.getElementById('activity-dot');
    const groupEl = document.getElementById('activity-group');
    const itemEl  = document.getElementById('activity-item');
    const msgEl   = document.getElementById('activity-message');
    const progEl  = document.getElementById('activity-progress');
    const titleEl = panel.querySelector('span.font-semibold');

    if (data.type === 'update_start') {
        activityDismissed = false;
        clearTimeout(activityHideTimer);
        const typeLabel = data.groupType === 'docker' ? 'Docker Group' : 'Server Group';
        titleEl.textContent = 'Auto-update running';
        dot.classList.remove('bg-green-400');
        dot.classList.add('bg-cyan-400', 'animate-pulse');
        groupEl.textContent = `${typeLabel}: ${escapeHtml(data.groupName)}`;
        itemEl.textContent = 'Starting…';
        msgEl.textContent = '';
        progEl.textContent = data.total ? `0 / ${data.total}` : '';
        panel.classList.remove('hidden');
    } else if (data.type === 'item_start') {
        if (activityDismissed) return;
        itemEl.textContent = escapeHtml(data.itemName);
        msgEl.textContent = '';
        if (data.current && data.total) progEl.textContent = `${data.current} / ${data.total}`;
    } else if (data.type === 'item_progress') {
        if (activityDismissed) return;
        itemEl.textContent = escapeHtml(data.itemName);
        msgEl.textContent = escapeHtml(data.message || '');
    } else if (data.type === 'update_done') {
        if (activityDismissed) return;
        titleEl.textContent = 'Auto-update finished';
        dot.classList.remove('animate-pulse', 'bg-cyan-400');
        dot.classList.add('bg-green-400');
        itemEl.textContent = 'Completed';
        msgEl.textContent = '';
        progEl.textContent = '';
        activityHideTimer = setTimeout(() => {
            panel.classList.add('hidden');
            dot.classList.remove('bg-green-400');
            dot.classList.add('bg-cyan-400');
        }, 10000);
        loadLogs();
        loadDashboard();
    }
}

function dismissActivity() {
    activityDismissed = true;
    clearTimeout(activityHideTimer);
    document.getElementById('activity-panel').classList.add('hidden');
}
