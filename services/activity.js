const clients = new Set();

function addClient(res) {
    clients.add(res);
    res.on('close', () => clients.delete(res));
}

function emit(data) {
    if (clients.size === 0) return;
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
        try { res.write(payload); } catch { clients.delete(res); }
    }
}

module.exports = { addClient, emit };
