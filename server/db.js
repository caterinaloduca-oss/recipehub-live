const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'recipehub.db');

let db;

function init() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      saved_at TEXT NOT NULL DEFAULT (datetime('now')),
      data_version INTEGER NOT NULL DEFAULT 0
    )
  `);

  return db;
}

function getState() {
  const row = db.prepare('SELECT data, saved_at, data_version FROM app_state WHERE id = 1').get();
  if (!row) return null;
  return {
    data: JSON.parse(row.data),
    savedAt: row.saved_at,
    dataVersion: row.data_version,
  };
}

function setState(jsonString, dataVersion) {
  const savedAt = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO app_state (id, data, saved_at, data_version) VALUES (1, ?, ?, ?)'
  ).run(jsonString, savedAt, dataVersion || 0);
  return savedAt;
}

module.exports = { init, getState, setState };
