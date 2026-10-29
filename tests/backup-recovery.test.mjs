import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createCipheriv } from "node:crypto";
import { checkBackup } from "../scripts/check-backup.mjs";
import { STRUCTURE_TABLES } from "../db/structure-schema.js";

const tables = [...STRUCTURE_TABLES, "customers", "work_logs", "work_log_properties", "listings", "listing_source_notes", "listing_events", "work_types", "property_buildings", "follow_ups", "trash_records"];
function fixture() {
  const data = Object.fromEntries(tables.map((name) => [name, []]));
  data.customers.push({ id: "test", name: "가상 고객" });
  data.work_logs.push({ id: "work", work_date: "2026-10-01", customer_id: "test", work_type: "전화", content: "가상 업무" });
  return { format: "jipjangbu-backup-v1", createdAt: "2026-10-01T00:00:00Z", tables: data, counts: Object.fromEntries(tables.map((name) => [name, data[name].length])) };
}

test("암호화된 백업을 격리 DB에 복구하고 건수와 관계를 검증한다", async () => {
  const backup = fixture(), key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([Buffer.from("JJB1"), iv, cipher.update(JSON.stringify(backup)), cipher.final(), cipher.getAuthTag()]);
  const result = await checkBackup(encrypted, key.toString("hex"));
  assert.equal(result.counts.work_logs, 1);
  await assert.rejects(checkBackup(encrypted, randomBytes(32).toString("hex")));
});

test("누락된 테이블, 건수 불일치 및 깨진 관계는 복구 성공으로 보고하지 않는다", async () => {
  const backup = fixture();
  backup.tables.work_logs[0].customer_id = "missing";
  await assert.rejects(checkBackup(Buffer.from(JSON.stringify(backup))), /연결 관계 오류/);
  backup.counts.customers = 2;
  await assert.rejects(checkBackup(Buffer.from(JSON.stringify(backup))), /건수 불일치/);
  delete backup.tables.customers;
  await assert.rejects(checkBackup(Buffer.from(JSON.stringify(backup))), /건수 불일치/);
});

test("독립 원본 메모와 attribution도 복구하며 과거 v1 백업은 원본 메모에서 이행한다", async () => {
  const current = fixture();
  current.tables.listing_source_notes.push({ identity_key: "아파트|보관|101|202", source_notes: "상태가 없어도 보관할 원문", event_history: "[]" });
  current.counts.listing_source_notes = 1;
  assert.equal((await checkBackup(Buffer.from(JSON.stringify(current)))).counts.listing_source_notes, 1);
  const legacy = fixture();
  delete legacy.tables.listing_source_notes;
  delete legacy.counts.listing_source_notes;
  legacy.tables.listings.push({ id: "listing", identity_key: "아파트|원본|101|202", registered_at: "2026-10-01", status: "매물등록", property_type: "아파트", building_name: "원본", source_notes: "이전 백업의 원본 메모" });
  legacy.counts.listings = 1;
  assert.equal((await checkBackup(Buffer.from(JSON.stringify(legacy)))).counts.listing_source_notes, 1);
  const partial = fixture();
  delete partial.counts.listing_source_notes;
  await assert.rejects(checkBackup(Buffer.from(JSON.stringify(partial))), /건수 불일치/);
  for (const event_history of ["not-json", "{}", "[null]", '[{"work_log_id":"work"}]']) {
    const invalid = fixture();
    invalid.tables.listing_source_notes.push({ identity_key: "invalid", source_notes: "합성 원문", event_history });
    invalid.counts.listing_source_notes = 1;
    await assert.rejects(checkBackup(Buffer.from(JSON.stringify(invalid))), /업무 연결 정보/);
  }
});
