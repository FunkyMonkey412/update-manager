const https = require('https');
const { URL } = require('url');

const REQUIRED_TAG = 'update-manager';

async function getConfig() {
    const { dbGet } = require('../db');
    const { decrypt } = require('../utils/crypto');
    const urlRow   = await dbGet("SELECT value FROM plugin_settings WHERE key = 'netbox_url'");
    const tokenRow = await dbGet("SELECT value FROM plugin_settings WHERE key = 'netbox_token'");
    const url   = urlRow?.value   || process.env.NETBOX_URL   || null;
    const token = tokenRow?.value ? decrypt(tokenRow.value)
                                  : (process.env.NETBOX_TOKEN || null);
    return { url, token };
}

async function isConfigured() {
    const { url, token } = await getConfig();
    return !!(url && token);
}

async function netboxRequest(path, overrideConfig) {
    const { url: baseUrl, token } = overrideConfig || await getConfig();
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(baseUrl + path); } catch (e) {
            return reject(new Error('Invalid NetBox URL: ' + e.message));
        }

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
                'Authorization': `Token ${token}`,
                'Accept': 'application/json'
            },
            rejectUnauthorized: false,
            timeout: 15000
        };

        const req = https.request(options, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`NetBox returned HTTP ${res.statusCode}`));
                }
                try { resolve(JSON.parse(body)); } catch (e) {
                    reject(new Error('NetBox returned invalid JSON'));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('NetBox request timed out')); });
        req.end();
    });
}

function stripCidr(address) {
    if (!address) return null;
    return address.split('/')[0];
}

function mapVm(vm) {
    return {
        id: vm.id,
        name: vm.name,
        ip: stripCidr(vm.primary_ip?.address),
        cluster: vm.cluster?.name || null,
        tags: (vm.tags || []).map(t => t.name)
    };
}

async function getVMs() {
    const data = await netboxRequest(
        `/api/virtualization/virtual-machines/?status=active&tag=${REQUIRED_TAG}&limit=1000`
    );
    return (data.results || [])
        .filter(vm => vm.primary_ip?.address)
        .map(mapVm);
}

async function getVM(id) {
    const vm = await netboxRequest(`/api/virtualization/virtual-machines/${id}/`);
    if (!vm.primary_ip?.address) throw new Error(`VM ${id} has no primary IP`);
    return mapVm(vm);
}

module.exports = { isConfigured, getConfig, netboxRequest, getVMs, getVM };
