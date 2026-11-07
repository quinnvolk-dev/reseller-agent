import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Must run before src/lib/db.js is imported: points the app at a throwaway database file.
export function useTempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'reseller-agent-test-'));
  const file = path.join(dir, 'agent.db');
  process.env.RESELLER_DB_PATH = file;
  return file;
}

// The listings + sales tables exactly as they were before multi-shop (from src/lib/db.js on main).
export const LEGACY_SCHEMA = `
  CREATE TABLE listings (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    query                TEXT NOT NULL,
    photos               TEXT,
    title                TEXT,
    description          TEXT,
    tags                 TEXT,
    condition_assessment TEXT,
    suggested_price      REAL,
    confidence           TEXT,
    flags                TEXT,
    actual_list_price    REAL DEFAULT NULL,
    actual_outcome       TEXT DEFAULT NULL
  );
  CREATE TABLE sales (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    sold_at           TEXT NOT NULL DEFAULT (datetime('now')),
    listing_id        INTEGER,
    item              TEXT NOT NULL,
    platform          TEXT NOT NULL DEFAULT 'ebay',
    sale_price        REAL NOT NULL,
    shipping_charged  REAL NOT NULL DEFAULT 0,
    cost_basis        REAL NOT NULL,
    platform_fees     REAL NOT NULL,
    fees_estimated    INTEGER NOT NULL DEFAULT 0,
    shipping_cost     REAL NOT NULL DEFAULT 0,
    other_costs       REAL NOT NULL DEFAULT 0,
    net_profit        REAL NOT NULL,
    margin_pct        REAL,
    notes             TEXT
  );
`;
