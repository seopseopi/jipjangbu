import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createCipheriv } from "node:crypto";
import { checkBackup } from "../scripts/check-backup.mjs";
import { STRUCTURE_TABLES } from "../db/structure-schema.js";

const tables = [...STRUCTURE_TABLES, "customers", "work_logs", "work_log_properties", "listings", "listing_events", "work_types", "property_buildings", "follow_ups", "trash_records"];
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
