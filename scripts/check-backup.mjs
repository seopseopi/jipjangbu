import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createDecipheriv, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { STRUCTURE_TABLES } from "../db/structure-schema.js";

const TABLES = [...STRUCTURE_TABLES, "customers", "work_logs", "work_log_properties", "listings", "listing_source_notes", "listing_events", "work_types", "property_buildings", "follow_ups", "trash_records"];

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
  // v1 backups created before the independent source archive remain restorable.
  // Recover its initial contents from the exact original notes and attribution
  // already present in those backups, never silently discard newer archives.
  if (!("listing_source_notes" in backup.tables) && !("listing_source_notes" in backup.counts)) {
    const events = Array.isArray(backup.tables.listing_events) ? backup.tables.listing_events : [];
    const sources = (Array.isArray(backup.tables.listings) ? backup.tables.listings : [])
      .filter((row) => typeof row.source_notes === "string" && row.source_notes !== "")
      .map((row) => ({ identity_key: row.identity_key, source_notes: row.source_notes,
        event_history: JSON.stringify(events.filter((event) => event.listing_key === row.identity_key)
          .map(({ work_log_id, event_date, status, notes }) => ({ work_log_id, event_date, status, notes }))),
        ...(typeof row.updated_at === "string" ? { updated_at: row.updated_at } : {}) }));
    backup.tables.listing_source_notes = sources;
    backup.counts.listing_source_notes = sources.length;
  }
  if (!("structure_plan_files" in backup.tables) && !("structure_plan_files" in backup.counts)) {
    backup.tables.structure_plan_files = []; backup.counts.structure_plan_files = 0;
  }
  const fileRows = backup.tables.structure_plan_files;
  let verifiedFileCount = 0;
  if (Array.isArray(fileRows) && fileRows.length) {
    if (!Array.isArray(backup.files) || backup.files.length !== fileRows.length) throw new Error("도면 원본 파일이 빠졌습니다. 사이트에서 백업을 내려받아 검증하세요.");
    const ids = new Set();
    for (const row of fileRows) {
      const matches = backup.files.filter(file => file.revision_id === row.revision_id);
      if (ids.has(row.revision_id) || matches.length !== 1 || !/^[a-f0-9-]{36}$/.test(row.revision_id) || !/^[a-f0-9]{64}$/.test(row.sha256)
        || row.storage_key !== `structure-files/${row.revision_id}/${row.sha256}`) throw new Error("도면 파일 연결이 올바르지 않습니다.");
      ids.add(row.revision_id);
      const file = matches[0];
      if (typeof file.base64 !== "string" || file.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.base64)) throw new Error("도면 파일 인코딩 오류");
      const content = Buffer.from(file.base64, "base64");
      if (content.toString("base64") !== file.base64 || content.length !== row.byte_size || file.sha256 !== row.sha256 || createHash("sha256").update(content).digest("hex") !== row.sha256) throw new Error("도면 파일 크기 또는 SHA-256 불일치");
      verifiedFileCount += 1;
    }
  } else if (backup.files?.length) throw new Error("도면 파일 연결이 올바르지 않습니다.");
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
        if (table === "listing_source_notes") {
          let history;
          try { history = JSON.parse(row.event_history ?? "[]"); } catch { throw new Error("원본 메모의 업무 연결 정보가 올바르지 않습니다."); }
          if (!Array.isArray(history) || history.some((event) => !event || typeof event !== "object"
            || ["work_log_id", "event_date", "status", "notes"].some((name) => typeof event[name] !== "string"))) {
            throw new Error("원본 메모의 업무 연결 정보가 올바르지 않습니다.");
          }
        }
        const names = Object.keys(row);
        if (!names.length || names.some((name) => !columns.has(name))) throw new Error(`복구 스키마와 열이 다릅니다: ${table}`);
        db.prepare(`INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map((name) => row[name]));
      }
      if (db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count !== rows.length) throw new Error(`복구 건수 불일치: ${table}`);
    }
    const foreignErrors = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignErrors.length) throw new Error(`복구 데이터의 연결 관계 오류: ${foreignErrors.length}건`);
    if (db.prepare("SELECT COUNT(*) n FROM structure_plan_revisions r LEFT JOIN structure_plan_files f ON f.revision_id=r.id WHERE json_type(r.geometry_json)='null' AND f.revision_id IS NULL").get().n) throw new Error("도면 원본 파일 연결이 빠졌습니다.");
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("복구 데이터 무결성 검사 실패");
    db.exec("COMMIT");
    return { createdAt: backup.createdAt, counts: backup.counts, verifiedFileCount };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error("사용법: node scripts/check-backup.mjs <백업 파일>");
    const result = await checkBackup(await readFile(process.argv[2]));
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) { console.error(`복구 검증 실패: ${error.message}`); process.exitCode = 1; }
}
