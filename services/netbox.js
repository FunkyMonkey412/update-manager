const https = require('https');
const { URL } = require('url');

const REQUIRED_TAG = 'update-manager';

function isConfigured() {
    return !!(process.env.NETBOX_URL && process.env.NETBOX_TOKEN);
}

function netboxRequest(path) {
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(process.env.NETBOX_URL + path); } catch (e) {
            return reject(new Error('Invalid NETBOX_URL: ' + e.message));
        }

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
                'Authorization': `Token ${process.env.NETBOX_TOKEN}`,
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

module.exports = { isConfigured, getVMs, getVM };
