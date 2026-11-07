import { mkdirSync } from 'fs';
import path from 'path';
import * as m001 from '../migrations/001_multi_shop.js';

// Add new migrations to the end of this list. Each runs once, in order, inside a transaction.
const MIGRATIONS = [m001];

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/**
 * Applies any pending migrations. Before the first pending one runs, the whole database is
 * copied to src/data/backups/ (VACUUM INTO gives a consistent snapshot even in WAL mode),
 * so a bad migration never costs you data. Returns the ids that were applied.
 */
export function migrate(db, { dbPath, log = console.log } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  const pending = MIGRATIONS.filter((m) => !applied.has(m.id));
  if (!pending.length) return [];

  if (dbPath && dbPath !== ':memory:') {
    const dir = path.join(path.dirname(dbPath), 'backups');
    mkdirSync(dir, { recursive: true });
    const backupPath = path.join(dir, `${path.basename(dbPath, '.db')}-${timestamp()}-before-${pending[0].id}.db`);
    db.prepare('VACUUM INTO ?').run(backupPath);
    log(`  Backed up database to ${backupPath} before migrating.`);
  }

  // ALTER TABLE ... ADD COLUMN ... REFERENCES with a non-NULL default is rejected while
  // foreign keys are enforced, and this pragma can't change inside a transaction.
  const fkWasOn = db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const m of pending) {
      db.exec('BEGIN');
      try {
        m.up(db);
        db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(m.id);
        db.exec('COMMIT');
        log(`  Applied migration ${m.id}.`);
      } catch (err) {
        db.exec('ROLLBACK');
        throw new Error(`Migration ${m.id} failed and was rolled back: ${err.message}`);
      }
    }
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) {
      throw new Error(`Foreign key check failed after migrating: ${JSON.stringify(violations.slice(0, 5))}`);
    }
  } finally {
    if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
  }

  return pending.map((m) => m.id);
}
