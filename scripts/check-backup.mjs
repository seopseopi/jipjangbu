import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createDecipheriv } from "node:crypto";
import { pathToFileURL } from "node:url";
import { STRUCTURE_TABLES } from "../db/structure-schema.js";

const TABLES = [...STRUCTURE_TABLES, "customers", "work_logs", "work_log_properties", "listings", "listing_events", "work_types", "property_buildings", "follow_ups", "trash_records"];

/** Restore to an isolated in-memory database, never to the production database. */
export async function checkBackup(input, key = process.env.BACKUP_ENCRYPTION_KEY) {
  let bytes = Buffer.from(input);
  if (bytes.subarray(0, 4).equals(Buffer.from("JJB1"))) {
    if (!/^[a-f0-9]{64}$/i.test(key ?? "") || bytes.length < 32) throw new Error("암호화 백업에는 32바이트 BACKUP_ENCRYPTION_KEY가 필요합니다.");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), bytes.subarray(4, 16));
    decipher.setAuthTag(bytes.subarray(-16));
    bytes = Buffer.concat([decipher.update(bytes.subarray(16, -16)), decipher.final()]);
  }
  const backup = JSON.parse(bytes.toString("utf8"));
  if (backup.format !== "jipjangbu-backup-v1" || !backup.tables || !backup.counts) throw new Error("지원하지 않는 백업 형식입니다.");
  if (Object.keys(backup.tables).some((table) => !TABLES.includes(table))) throw new Error("알 수 없는 테이블이 포함되어 있습니다.");
  const db = new DatabaseSync(":memory:");
  try {
    const migrations = (await readdir(new URL("../drizzle/", import.meta.url))).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    db.exec("PRAGMA foreign_keys = OFF");
    for (const name of migrations) db.exec(await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8"));
    db.exec("BEGIN");
    for (const table of TABLES) {
      const rows = backup.tables[table];
      if (!Array.isArray(rows) || backup.counts[table] !== rows.length) throw new Error(`백업 건수 불일치: ${table}`);
      const columns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name));
      if (!columns.size) throw new Error(`복구 스키마에 테이블이 없습니다: ${table}`);
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`잘못된 행: ${table}`);
        const names = Object.keys(row);
        if (!names.length || names.some((name) => !columns.has(name))) throw new Error(`복구 스키마와 열이 다릅니다: ${table}`);
        db.prepare(`INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map((name) => row[name]));
      }
      if (db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count !== rows.length) throw new Error(`복구 건수 불일치: ${table}`);
    }
    const foreignErrors = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignErrors.length) throw new Error(`복구 데이터의 연결 관계 오류: ${foreignErrors.length}건`);
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("복구 데이터 무결성 검사 실패");
    db.exec("COMMIT");
    return { createdAt: backup.createdAt, counts: backup.counts };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error("사용법: node scripts/check-backup.mjs <백업 파일>");
    const result = await checkBackup(await readFile(process.argv[2]));
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) { console.error(`복구 검증 실패: ${error.message}`); process.exitCode = 1; }
}
