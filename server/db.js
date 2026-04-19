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
    );

    CREATE TABLE IF NOT EXISTS ebs_cost_history (
      item_number TEXT NOT NULL,
      period_code TEXT NOT NULL,
      item_desc TEXT,
      uom TEXT,
      accounting_cost REAL,
      compnent_cost REAL,
      cost_component_class TEXT,
      organization_code TEXT,
      start_date TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (item_number, period_code, cost_component_class)
    );

    CREATE INDEX IF NOT EXISTS idx_ebs_item ON ebs_cost_history(item_number);
    CREATE INDEX IF NOT EXISTS idx_ebs_period ON ebs_cost_history(period_code);

    CREATE TABLE IF NOT EXISTS ebs_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      rows_synced INTEGER,
      status TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS ebs_item_map (
      inv_item_id TEXT PRIMARY KEY,
      description TEXT,
      recipe_unit TEXT,
      stockroom_unit TEXT,
      equivalence REAL,
      export_id TEXT,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ebs_map_export ON ebs_item_map(export_id);

    -- User-maintained POS→ERP mapping. Overrides ebs_item_map.export_id when present.
    CREATE TABLE IF NOT EXISTS local_item_map (
      inv_item_id TEXT PRIMARY KEY,
      erp_item_number TEXT NOT NULL,
      mapped_by TEXT,
      mapped_at TEXT NOT NULL DEFAULT (datetime('now')),
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_local_map_erp ON local_item_map(erp_item_number);
  `);

  return db;
}

function getLatestPrices() {
  return db.prepare(`
    SELECT h.item_number, h.item_desc, h.uom, h.accounting_cost, h.compnent_cost, h.period_code, h.start_date
    FROM ebs_cost_history h
    JOIN (
      SELECT item_number, MAX(start_date) AS max_date
      FROM ebs_cost_history
      WHERE cost_component_class = 'MATERIAL'
      GROUP BY item_number
    ) m ON m.item_number = h.item_number AND m.max_date = h.start_date
    WHERE h.cost_component_class = 'MATERIAL'
    ORDER BY h.item_desc
  `).all();
}

function getPriceHistory(itemNumber) {
  return db.prepare(`
    SELECT period_code, start_date, accounting_cost, compnent_cost, uom, item_desc, cost_component_class
    FROM ebs_cost_history
    WHERE item_number = ?
    ORDER BY start_date DESC
  `).all(itemNumber);
}

function searchPrices(q) {
  const like = '%' + q.toLowerCase() + '%';
  return db.prepare(`
    SELECT h.item_number, h.item_desc, h.uom, h.accounting_cost, h.period_code, h.start_date
    FROM ebs_cost_history h
    JOIN (
      SELECT item_number, MAX(start_date) AS max_date
      FROM ebs_cost_history
      WHERE cost_component_class = 'MATERIAL'
      GROUP BY item_number
    ) m ON m.item_number = h.item_number AND m.max_date = h.start_date
    WHERE h.cost_component_class = 'MATERIAL'
      AND (LOWER(h.item_desc) LIKE ? OR LOWER(h.item_number) LIKE ?)
    ORDER BY h.item_desc
    LIMIT 40
  `).all(like, like);
}

function upsertCostRows(rows) {
  const stmt = db.prepare(`
    INSERT INTO ebs_cost_history
      (item_number, period_code, item_desc, uom, accounting_cost, compnent_cost, cost_component_class, organization_code, start_date, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(item_number, period_code, cost_component_class) DO UPDATE SET
      item_desc = excluded.item_desc,
      uom = excluded.uom,
      accounting_cost = excluded.accounting_cost,
      compnent_cost = excluded.compnent_cost,
      organization_code = excluded.organization_code,
      start_date = excluded.start_date,
      synced_at = datetime('now')
  `);
  const tx = db.transaction((rs) => {
    for (const r of rs) {
      stmt.run(
        r.item_number, r.period_code, r.item_desc || null, r.uom || null,
        r.accounting_cost != null ? Number(r.accounting_cost) : null,
        r.compnent_cost != null ? Number(r.compnent_cost) : null,
        r.cost_component_class || 'MATERIAL',
        r.organization_code || null,
        r.start_date || null
      );
    }
  });
  tx(rows);
  return rows.length;
}

function upsertItemMap(rows) {
  const stmt = db.prepare(`
    INSERT INTO ebs_item_map (inv_item_id, description, recipe_unit, stockroom_unit, equivalence, export_id, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(inv_item_id) DO UPDATE SET
      description = excluded.description,
      recipe_unit = excluded.recipe_unit,
      stockroom_unit = excluded.stockroom_unit,
      equivalence = excluded.equivalence,
      export_id = excluded.export_id,
      synced_at = datetime('now')
  `);
  const tx = db.transaction((rs) => { for (const r of rs) stmt.run(r.inv_item_id, r.description, r.recipe_unit, r.stockroom_unit, r.equivalence, r.export_id); });
  tx(rows);
  return rows.length;
}

function getItemMap(invItemId) {
  // Local user mapping wins over the synced POS mapping
  const local = db.prepare('SELECT * FROM local_item_map WHERE inv_item_id = ?').get(invItemId);
  const base = db.prepare('SELECT * FROM ebs_item_map WHERE inv_item_id = ?').get(invItemId);
  if (!local) return base;
  return {
    inv_item_id: invItemId,
    description: base ? base.description : null,
    recipe_unit: base ? base.recipe_unit : null,
    stockroom_unit: base ? base.stockroom_unit : null,
    equivalence: base ? base.equivalence : null,
    export_id: local.erp_item_number,
    mapped_by: local.mapped_by,
    mapped_at: local.mapped_at,
    local: true,
  };
}

function setLocalMap(invItemId, erpItemNumber, mappedBy, notes) {
  return db.prepare(`
    INSERT INTO local_item_map (inv_item_id, erp_item_number, mapped_by, notes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(inv_item_id) DO UPDATE SET
      erp_item_number = excluded.erp_item_number,
      mapped_by = excluded.mapped_by,
      notes = excluded.notes,
      mapped_at = datetime('now')
  `).run(invItemId, erpItemNumber, mappedBy || null, notes || null);
}

function deleteLocalMap(invItemId) {
  return db.prepare('DELETE FROM local_item_map WHERE inv_item_id = ?').run(invItemId);
}

function listLocalMaps() {
  return db.prepare('SELECT * FROM local_item_map ORDER BY mapped_at DESC').all();
}

function getSyncLog(limit) {
  return db.prepare('SELECT * FROM ebs_sync_log ORDER BY started_at DESC LIMIT ?').all(limit || 10);
}

function logSyncStart() {
  return db.prepare(`INSERT INTO ebs_sync_log (started_at, status) VALUES (datetime('now'), 'running')`).run().lastInsertRowid;
}

function logSyncEnd(id, rowsSynced, error) {
  db.prepare(`UPDATE ebs_sync_log SET finished_at = datetime('now'), rows_synced = ?, status = ?, error = ? WHERE id = ?`)
    .run(rowsSynced, error ? 'error' : 'ok', error || null, id);
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

module.exports = {
  init, getState, setState,
  getLatestPrices, getPriceHistory, searchPrices, upsertCostRows,
  upsertItemMap, getItemMap,
  setLocalMap, deleteLocalMap, listLocalMaps,
  getSyncLog, logSyncStart, logSyncEnd,
};
