/**
 * dbSchema.ts — bảng của Public API & Plugin.
 *
 * Tạo LAZY khi tính năng được dùng lần đầu trên mỗi file DB (workspace), không chạy
 * trong luồng khởi tạo DB của app → không ảnh hưởng người không dùng API.
 * Chỉ CREATE TABLE/INDEX IF NOT EXISTS, không ALTER bảng cũ.
 */

export const API_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  key_prefix         TEXT NOT NULL,
  key_hash           TEXT NOT NULL,
  scopes_json        TEXT NOT NULL DEFAULT '[]',
  account_ids_json   TEXT DEFAULT NULL,
  allowed_ips_json   TEXT DEFAULT NULL,
  rate_limit_per_min INTEGER NOT NULL DEFAULT 0,
  erp_role           TEXT NOT NULL DEFAULT 'manager',
  plugin_id          TEXT DEFAULT NULL,
  note               TEXT NOT NULL DEFAULT '',
  created_by         TEXT NOT NULL DEFAULT 'boss',
  created_at         INTEGER NOT NULL,
  last_used_at       INTEGER DEFAULT NULL,
  last_used_ip       TEXT DEFAULT NULL,
  expires_at         INTEGER DEFAULT NULL,
  revoked_at         INTEGER DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

CREATE TABLE IF NOT EXISTS api_request_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL,
  method       TEXT NOT NULL,
  route        TEXT NOT NULL,
  status       INTEGER NOT NULL,
  took_ms      INTEGER NOT NULL,
  ip           TEXT DEFAULT '',
  request_id   TEXT DEFAULT '',
  error_code   TEXT DEFAULT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_logs_principal_time ON api_request_logs(principal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_api_logs_time ON api_request_logs(created_at);

CREATE TABLE IF NOT EXISTS api_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL,
  account_id   TEXT DEFAULT '',
  channel      TEXT DEFAULT '',
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_events_type_seq ON api_events(type, seq);
CREATE INDEX IF NOT EXISTS idx_api_events_created ON api_events(created_at);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                   TEXT PRIMARY KEY,
  key_id               TEXT DEFAULT NULL,
  name                 TEXT NOT NULL DEFAULT '',
  url                  TEXT NOT NULL,
  secret               TEXT NOT NULL,
  events_json          TEXT NOT NULL DEFAULT '["*"]',
  account_ids_json     TEXT DEFAULT NULL,
  active               INTEGER NOT NULL DEFAULT 1,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  disabled_reason      TEXT DEFAULT NULL,
  allow_private        INTEGER NOT NULL DEFAULT 0,
  last_delivery_at     INTEGER DEFAULT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  event_seq       INTEGER NOT NULL,
  event_type      TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  response_status INTEGER DEFAULT NULL,
  response_body   TEXT DEFAULT NULL,
  error           TEXT DEFAULT NULL,
  next_retry_at   INTEGER DEFAULT NULL,
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER DEFAULT NULL,
  FOREIGN KEY (subscription_id) REFERENCES webhook_subscriptions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_wh_deliveries_due ON webhook_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_wh_deliveries_sub ON webhook_deliveries(subscription_id, created_at);

CREATE TABLE IF NOT EXISTS plugins (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  version                  TEXT NOT NULL,
  runtime                  TEXT NOT NULL,
  source_type              TEXT NOT NULL,
  install_path             TEXT NOT NULL,
  manifest_json            TEXT NOT NULL,
  granted_permissions_json TEXT NOT NULL DEFAULT '[]',
  account_ids_json         TEXT DEFAULT NULL,
  settings_json            TEXT NOT NULL DEFAULT '{}',
  status                   TEXT NOT NULL DEFAULT 'disabled',
  status_reason            TEXT DEFAULT NULL,
  installed_at             INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_storage (
  plugin_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, key)
);

CREATE TABLE IF NOT EXISTS plugin_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id  TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info',
  message    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_logs ON plugin_logs(plugin_id, id);
`;

export const API_TABLES = [
    'api_keys', 'api_request_logs', 'api_events', 'webhook_subscriptions',
    'webhook_deliveries', 'plugins', 'plugin_storage', 'plugin_logs',
] as const;

/** Bề mặt DB tối thiểu mà các service API dùng (DatabaseService thật thoả mãn; test dùng node:sqlite). */
export interface ApiDb {
    exec(sql: string): void;
    run(sql: string, params?: any[]): void;
    runChanges(sql: string, params?: any[]): number;
    /** INSERT và trả rowid mới. */
    runInsert(sql: string, params?: any[]): number;
    query<T = any>(sql: string, params?: any[]): T[];
    queryOne<T = any>(sql: string, params?: any[]): T | undefined;
    transaction<T>(fn: () => T): T;
    getDbPath?(): string;
}

const ensured = new Set<string>();
let dbProvider: (() => ApiDb) | null = null;

/** Thay nguồn DB (test). null = DatabaseService.getInstance(). */
export function setApiDbProvider(provider: (() => ApiDb) | null): void {
    dbProvider = provider;
    ensured.clear();
}

/** Bảng API đã tồn tại trên DB hiện tại chưa (không tạo bảng). */
export function apiTablesExist(): boolean {
    try {
        const db: ApiDb = dbProvider
            ? dbProvider()
            : require('../database/DatabaseService').default.getInstance();
        const key = (db.getDbPath && db.getDbPath()) || 'default';
        if (ensured.has(key)) return true;
        const row = db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='api_keys'");
        return Number(row?.n) > 0;
    } catch {
        return false;
    }
}

/** Cột thêm sau khi bảng đã tồn tại ở máy người dùng: [bảng, cột, kiểu]. */
const COLUMN_MIGRATIONS: Array<[string, string, string]> = [
    ['webhook_subscriptions', 'allow_private', 'INTEGER NOT NULL DEFAULT 0'],
];

function migrateColumns(db: ApiDb): void {
    for (const [table, column, ddl] of COLUMN_MIGRATIONS) {
        const cols = db.query<{ name: string }>(`PRAGMA table_info(${table})`);
        if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
}

/** DB đã đảm bảo có bảng API. Gọi ở mọi chỗ cần đọc/ghi bảng API. */
export function apiDb(): ApiDb {
    const db: ApiDb = dbProvider
        ? dbProvider()
        : require('../database/DatabaseService').default.getInstance();
    const key = (db.getDbPath && db.getDbPath()) || 'default';
    if (!ensured.has(key)) {
        db.exec(API_SCHEMA_SQL);
        migrateColumns(db);
        ensured.add(key);
    }
    return db;
}
