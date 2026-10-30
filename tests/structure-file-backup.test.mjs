import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { portableBackupStream } from "../worker/structure-file-export.ts";
import { checkBackup } from "../scripts/check-backup.mjs";
import { STRUCTURE_TABLES } from "../db/structure-schema.js";

function fixture(content) {
  const tables = Object.fromEntries([...STRUCTURE_TABLES,"customers","work_logs","work_log_properties","listings","listing_source_notes","listing_events","work_types","property_buildings","follow_ups","trash_records"].map(t => [t, []]));
  const id = "11111111-1111-4111-8111-111111111111", sha = createHash("sha256").update(content).digest("hex");
  tables.structure_complexes.push({ id: "complex", name: "합성단지", address: "합성주소", evidence: "테스트" });
  tables.structure_plan_types.push({ id: "type", complex_id: "complex", name: "타입" });
  tables.structure_plan_revisions.push({ id, type_id: "type", version: 1, geometry_json: "null", source: "합성 원본", permission_evidence: "테스트", variant: "base" });
  tables.structure_plan_files.push({ revision_id: id, storage_key: `structure-files/${id}/${sha}`, file_name: "합성.pdf", mime_type: "application/pdf", byte_size: content.length, sha256: sha });
  return { format: "jipjangbu-backup-v1", tables, counts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])) };
}
const bytesOf = obj => new TextEncoder().encode(JSON.stringify(obj)).buffer;
function bucket(content) {
  return {
    async head() { return { size: content.length }; },
    async get() { return { size: content.length, body: new ReadableStream({ start(c) {
      // Deliberately split Base64 triples across incoming chunks.
      for (let i = 0; i < content.length; i += 65537) c.enqueue(content.subarray(i, i + 65537));
      c.close();
    } }) }; },
  };
}

test("파일 포함 백업은 바이트를 보존하고 격리 DB 및 파일로 복구된다", async () => {
  const original = Buffer.alloc(2 * 1024 * 1024 + 5, 127); original.write("%PDF-1.7");
  const data = fixture(original);
  const processing={page:7,crop:{x:.2,y:.3,width:.4,height:.5},plan:null,note:"합성 영역 분리"};
  data.tables.structure_plan_processing.push({revision_id:data.tables.structure_plan_revisions[0].id,processing_json:JSON.stringify(processing),row_version:2});
  data.counts.structure_plan_processing=1;
  const stream = await portableBackupStream(bytesOf(data), bucket(original));
  const exported = Buffer.from(await new Response(stream).arrayBuffer());
  const parsed = JSON.parse(exported.toString());
  assert.deepEqual(Buffer.from(parsed.files[0].base64, "base64"), original);
  const checked = await checkBackup(exported);
  assert.equal(checked.verifiedFileCount, 1);
  assert.equal(checked.counts.structure_plan_revisions, 1);
  assert.equal(checked.counts.structure_plan_processing,1);
  assert.deepEqual(JSON.parse(parsed.tables.structure_plan_processing[0].processing_json),processing);
  const restoredBucket = new Map(parsed.files.map(f => [data.tables.structure_plan_files.find(row => row.revision_id === f.revision_id).storage_key, Buffer.from(f.base64, "base64")]));
  assert.deepEqual(restoredBucket.get(data.tables.structure_plan_files[0].storage_key), original);
});

test("파일 누락·훼손·다른 객체 참조는 백업 성공으로 처리하지 않는다", async () => {
  const original = Buffer.from("%PDF-1.4 synthetic bytes"), data = fixture(original);
  await assert.rejects(portableBackupStream(bytesOf(data), { async head() { return null; } }), /missing/);
  const invalid = structuredClone(data); invalid.tables.structure_plan_files[0].storage_key = "manual/private.json.enc";
  await assert.rejects(portableBackupStream(bytesOf(invalid), bucket(original)), /Invalid/);
  await assert.rejects(checkBackup(Buffer.from(JSON.stringify(data))), /원본 파일이 빠졌/);
  const exported = JSON.parse(await new Response(await portableBackupStream(bytesOf(data), bucket(original))).text());
  exported.files[0].base64 = Buffer.from("different data").toString("base64");
  await assert.rejects(checkBackup(Buffer.from(JSON.stringify(exported))), /SHA-256/);
});

test("이전 파일 없는 백업은 계속 복구되며 파일 연결만 빠진 새 백업은 거절된다", async () => {
  const original = Buffer.from("%PDF-1.4 synthetic bytes"), data = fixture(original);
  data.tables.structure_plan_files = []; data.counts.structure_plan_files = 0;
  await assert.rejects(checkBackup(Buffer.from(JSON.stringify(data))), /원본 파일 연결/);
  data.tables.structure_plan_revisions = []; data.counts.structure_plan_revisions = 0;
  delete data.tables.structure_plan_files; delete data.counts.structure_plan_files;
  assert.equal((await checkBackup(Buffer.from(JSON.stringify(data)))).verifiedFileCount, 0);
});
