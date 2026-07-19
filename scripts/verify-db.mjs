// One-off DB verification: confirm migrations ran and schema matches design.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const dbPath = join(process.env.APPDATA, "app.zhujian.notebook", "notebook.sqlite3");
const db = new DatabaseSync(dbPath, { readOnly: true });

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name)
  .filter((n) => !n.startsWith("sqlite_"));

const indexes = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
  .all()
  .map((r) => r.name);

const userVersion = db.prepare("PRAGMA user_version").get().user_version;
const fkRow = db.prepare("PRAGMA foreign_keys").get();
// ㉜ 单实体(0014):notes+tasks 已合并为 items;按 stage 分组看灵感态/任务态/回收站。
const itemCount = db.prepare("SELECT COUNT(*) AS c FROM items").get().c;
const byStage = db
  .prepare("SELECT stage, COUNT(*) AS c FROM items GROUP BY stage ORDER BY stage")
  .all()
  .map((r) => `${r.stage}:${r.c}`)
  .join("  ");
const trash = db.prepare("SELECT COUNT(*) AS c FROM items WHERE archived_at IS NOT NULL").get().c;

console.log("user_version :", userVersion);
console.log("foreign_keys (this conn):", JSON.stringify(fkRow));
console.log("tables       :", tables.join(", "));
console.log("idx_*        :", indexes.join(", "));
console.log("items count  :", itemCount, " (回收站", trash + ")");
console.log("by stage     :", byStage);
console.log("items DDL    :\n" +
  db.prepare("SELECT sql FROM sqlite_master WHERE name='items'").get().sql);
