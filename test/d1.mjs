// Minimal D1 shim over node:sqlite so we can exercise the real worker
// handlers against the real migrations.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.binds = []; }
  bind(...args) { const s = new Stmt(this.db, this.sql); s.binds = args.map(norm); return s; }
  async first(col) {
    const st = this.db.prepare(this.sql);
    const row = st.get(...this.binds);
    if (row === undefined) return null;
    return col ? row[col] : row;
  }
  async all() {
    const st = this.db.prepare(this.sql);
    return { results: st.all(...this.binds), success: true };
  }
  async run() {
    const st = this.db.prepare(this.sql);
    const r = st.run(...this.binds);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export class D1 {
  constructor(migrationsDir) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON;");
    for (const f of readdirSync(migrationsDir).sort()) {
      if (!f.endsWith(".sql")) continue;
      this.db.exec(readFileSync(path.join(migrationsDir, f), "utf8"));
    }
  }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
  async exec(sql) { this.db.exec(sql); return { count: 1, duration: 0 }; }
}

export class KV {
  constructor() { this.m = new Map(); }
  async get(k, type) {
    const v = this.m.get(k);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
  async list() { return { keys: [...this.m.keys()].map((name) => ({ name })) }; }
}
