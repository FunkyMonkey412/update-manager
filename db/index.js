const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/servers.db');
const db = new sqlite3.Database(DB_PATH);

// Promise wrappers
function dbGet(query, params = []) {
    return new Promise((resolve, reject) =>
        db.get(query, params, (err, row) => err ? reject(err) : resolve(row))
    );
}

function dbAll(query, params = []) {
    return new Promise((resolve, reject) =>
        db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows))
    );
}

function dbRun(query, params = []) {
    return new Promise((resolve, reject) =>
        db.run(query, params, function(err) { err ? reject(err) : resolve(this); })
    );
}

const MIGRATIONS = [
    {
        id: 1,
        name: 'initial_schema',
        sql: `
            CREATE TABLE IF NOT EXISTS server_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                description TEXT,
                auto_update_interval INTEGER,
                auto_update_interval_unit TEXT CHECK(auto_update_interval_unit IN ('hours','days','weeks','months')),
                auto_update_start_date TEXT,
                auto_reboot_if_required BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS servers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                ip_address TEXT NOT NULL,
                port INTEGER DEFAULT 22,
                username TEXT NOT NULL,
                auth_type TEXT NOT NULL CHECK(auth_type IN ('password','ssh_key')),
                password_hash TEXT,
                ssh_key_path TEXT,
                sudo_password_hash TEXT,
                group_id INTEGER,
                status TEXT DEFAULT 'unknown',
                last_update DATETIME,
                needs_reboot BOOLEAN DEFAULT 0,
                auto_update BOOLEAN DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (group_id) REFERENCES server_groups(id)
            );
            CREATE TABLE IF NOT EXISTS docker_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                description TEXT,
                auto_update_interval INTEGER,
                auto_update_interval_unit TEXT CHECK(auto_update_interval_unit IN ('hours','days','weeks','months')),
                auto_update_start_date TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS docker_hosts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                ip_address TEXT NOT NULL,
                port INTEGER DEFAULT 22,
                username TEXT NOT NULL,
                auth_type TEXT NOT NULL CHECK(auth_type IN ('password','ssh_key')),
                password_hash TEXT,
                ssh_key_path TEXT,
                sudo_password_hash TEXT,
                docker_compose_command TEXT,
                group_id INTEGER,
                status TEXT DEFAULT 'unknown',
                last_update DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (group_id) REFERENCES docker_groups(id)
            );
            CREATE TABLE IF NOT EXISTS docker_compose_projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                compose_file_path TEXT NOT NULL,
                working_directory TEXT NOT NULL,
                status TEXT DEFAULT 'unknown',
                last_update DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (host_id) REFERENCES docker_hosts(id) ON DELETE CASCADE,
                UNIQUE(host_id, compose_file_path)
            );
            CREATE TABLE IF NOT EXISTS update_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type TEXT NOT NULL CHECK(entity_type IN ('server','docker','group','docker_group')),
                entity_id INTEGER NOT NULL,
                entity_name TEXT NOT NULL,
                update_type TEXT NOT NULL CHECK(update_type IN ('manual','automatic')),
                success BOOLEAN NOT NULL,
                message TEXT,
                details TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `
    },
    {
        id: 3,
        name: 'credential_vault',
        sql: `
            CREATE TABLE IF NOT EXISTS credentials (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                auth_type TEXT NOT NULL CHECK(auth_type IN ('password','ssh_key')),
                username TEXT NOT NULL,
                password_hash TEXT,
                ssh_key_path TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE servers ADD COLUMN credential_id INTEGER REFERENCES credentials(id);
            ALTER TABLE docker_hosts ADD COLUMN credential_id INTEGER REFERENCES credentials(id);
        `
    },
    {
        id: 4,
        name: 'webhooks',
        sql: `
            CREATE TABLE IF NOT EXISTS webhooks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                enabled INTEGER DEFAULT 1,
                notify_success INTEGER DEFAULT 1,
                notify_failure INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `
    },
    {
        id: 5,
        name: 'plugin_settings',
        sql: `
            CREATE TABLE IF NOT EXISTS plugin_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `
    },
    {
        id: 2,
        name: 'add_missing_columns',
        sql: `
            ALTER TABLE servers ADD COLUMN sudo_password_hash TEXT;
            ALTER TABLE servers ADD COLUMN needs_reboot BOOLEAN DEFAULT 0;
            ALTER TABLE server_groups ADD COLUMN auto_update_interval_unit TEXT;
            ALTER TABLE server_groups ADD COLUMN auto_update_start_date TEXT;
            ALTER TABLE server_groups ADD COLUMN auto_reboot_if_required BOOLEAN DEFAULT 0;
            ALTER TABLE docker_hosts ADD COLUMN sudo_password_hash TEXT;
            ALTER TABLE update_logs ADD COLUMN details TEXT;
        `
    }
];

async function runMigrations() {
    // Create migrations table
    await dbRun(`CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    const applied = await dbAll('SELECT id FROM schema_migrations');
    const appliedIds = new Set(applied.map(r => r.id));

    for (const migration of MIGRATIONS) {
        if (appliedIds.has(migration.id)) continue;

        console.log(`[db] Applying migration ${migration.id}: ${migration.name}`);
        // Run each statement individually, ignoring "duplicate column" errors (idempotent)
        const statements = migration.sql
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        for (const stmt of statements) {
            try {
                await dbRun(stmt);
            } catch (err) {
                if (err.message.includes('duplicate column name') ||
                    err.message.includes('already exists')) {
                    // Already applied — fine
                } else {
                    throw err;
                }
            }
        }

        await dbRun('INSERT INTO schema_migrations (id, name) VALUES (?, ?)',
            [migration.id, migration.name]);
        console.log(`[db] Migration ${migration.id} applied`);
    }
}

module.exports = { db, dbGet, dbAll, dbRun, runMigrations };
