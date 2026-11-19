import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export function openStore(directory) {
  // Each running simulator has its own WebSocket sessions and publisher. SQLite releases
  // this separate lock automatically if the owning process exits unexpectedly.
  const lock = new DatabaseSync(join(directory, 'instance.sqlite'));
  try {
    lock.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    throw new Error('Another Fold pilot is already using this data directory.', { cause: error });
  }
  const db = new DatabaseSync(join(directory, 'fold.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS release (
      version INTEGER PRIMARY KEY,
      manifest TEXT NOT NULL,
      signature TEXT NOT NULL,
      wasm BLOB NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS device (
      id TEXT PRIMARY KEY,
      desired TEXT NOT NULL,
      installed TEXT,
      applied_at TEXT,
      ack_ms REAL,
      error TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES device(id),
      version INTEGER NOT NULL REFERENCES release(version),
      wire_version INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS orders (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL UNIQUE REFERENCES session(id),
      idempotency_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('received', 'preparing', 'ready', 'completed')),
      receipt TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS orders_queue ON orders(status, sequence DESC);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY,
      category TEXT NOT NULL,
      time TEXT NOT NULL,
      event TEXT NOT NULL,
      detail TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS audit_category ON audit(category, id DESC);
  `);
  const statements = new Map();
  function statement(sql) {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  }
  const run = (sql, ...args) => statement(sql).run(...args);
  const get = (sql, ...args) => statement(sql).get(...args);
  const all = (sql, ...args) => statement(sql).all(...args);
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function read(key) {
    const row = get('SELECT value FROM config WHERE key = ?', key);
    return row ? JSON.parse(row.value) : null;
  }
  function write(key, value) {
    run('INSERT INTO config VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }
  function audit(category, event, detail) {
    run('INSERT INTO audit(category, time, event, detail) VALUES (?, ?, ?, ?)', category, now(), event, detail);
  }
  function history(category) {
    const columns = 'SELECT id, category, time, event, detail FROM audit';
    return category ? all(`${columns} WHERE category = ? ORDER BY id DESC LIMIT 60`, category)
      : all(`${columns} ORDER BY id DESC LIMIT 200`);
  }
  return { run, get, all, read, write, transaction, audit, history, close() { db.close(); lock.close(); } };
}

export const now = () => new Date().toISOString();
