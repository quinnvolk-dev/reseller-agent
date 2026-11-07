// TEST-ONLY stand-in for better-sqlite3, built on Node's built-in node:sqlite. Used by the test
// runner only when the real better-sqlite3 native module can't load (e.g. a machine without
// Python/C++ build tools). Covers just the API surface this project uses.
import { DatabaseSync } from 'node:sqlite';

const plain = (row) => (row == null ? row : { ...row });

class Statement {
  constructor(stmt) {
    this.stmt = stmt;
  }
  run(...args) {
    const r = this.stmt.run(...args);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  get(...args) {
    return plain(this.stmt.get(...args));
  }
  all(...args) {
    return this.stmt.all(...args).map(plain);
  }
}

export default class Database {
  constructor(file) {
    this.inner = new DatabaseSync(file);
    this.inner.exec('PRAGMA foreign_keys = ON'); // better-sqlite3's default
  }
  prepare(sql) {
    return new Statement(this.inner.prepare(sql));
  }
  exec(sql) {
    this.inner.exec(sql);
    return this;
  }
  pragma(source) {
    return this.inner.prepare(`PRAGMA ${source}`).all().map(plain);
  }
  transaction(fn) {
    return (...args) => {
      this.inner.exec('BEGIN');
      try {
        const out = fn(...args);
        this.inner.exec('COMMIT');
        return out;
      } catch (err) {
        this.inner.exec('ROLLBACK');
        throw err;
      }
    };
  }
  close() {
    this.inner.close();
  }
}
