// Builds a small fake ERP database (WAL mode) for tests. Column lists are trimmed copies of the real ERP's
// CREATE statements (server.js, modules/payroll2.js, procurement.js, assets.js, siteops.js, hired.js),
// each keeping at least one column the reader does not use. Fake data only.
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE employees(id INTEGER PRIMARY KEY, name TEXT NOT NULL, designation TEXT, status TEXT DEFAULT 'active', iban TEXT, project_id INTEGER);
CREATE TABLE payroll(id INTEGER PRIMARY KEY, month TEXT, employee_id INTEGER, project_id INTEGER, days_worked REAL DEFAULT 30, overtime REAL DEFAULT 0, gross REAL DEFAULT 0, net REAL DEFAULT 0, status TEXT DEFAULT 'draft', UNIQUE(month, employee_id));
CREATE TABLE payroll_alloc(id INTEGER PRIMARY KEY, payroll_id INTEGER, project_id INTEGER, days REAL, amount REAL);
CREATE TABLE eos_provisions(id INTEGER PRIMARY KEY, month TEXT, employee_id INTEGER, amount REAL, days_rate REAL, UNIQUE(month, employee_id));
CREATE TABLE bills(id INTEGER PRIMARY KEY, date TEXT, party_id INTEGER, project_id INTEGER, category TEXT DEFAULT 'materials', description TEXT, amount REAL DEFAULT 0, vat_amount REAL DEFAULT 0);
CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY, number TEXT, date TEXT, party_id INTEGER, status TEXT DEFAULT 'draft', items TEXT DEFAULT '[]', vat_pct REAL DEFAULT 5);
CREATE TABLE fixed_assets(id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT, serial TEXT, cost REAL DEFAULT 0, salvage REAL DEFAULT 0, life_years REAL DEFAULT 5, status TEXT DEFAULT 'active', project_id INTEGER);
CREATE TABLE equipment_logs(id INTEGER PRIMARY KEY, asset_id INTEGER, date TEXT, kind TEXT, hours REAL DEFAULT 0, litres REAL DEFAULT 0, cost REAL DEFAULT 0);
CREATE TABLE hire_items(id INTEGER PRIMARY KEY, type TEXT, source TEXT DEFAULT 'supplier', name TEXT NOT NULL, basis TEXT DEFAULT 'month', rate REAL DEFAULT 0, base_hours REAL DEFAULT 260, status TEXT DEFAULT 'active');
CREATE TABLE projects(id INTEGER PRIMARY KEY, code TEXT, name TEXT NOT NULL, contract_value REAL DEFAULT 0, start_date TEXT, end_date TEXT, status TEXT DEFAULT 'active');
`;

// data: { tableName: [ {col: value, ...}, ... ] }
function makeErp(file, data = {}) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(SCHEMA);
    for (const [table, rows] of Object.entries(data)) {
      for (const row of rows) {
        const cols = Object.keys(row);
        db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c]));
      }
    }
  } finally { db.close(); }
}

module.exports = { makeErp };
