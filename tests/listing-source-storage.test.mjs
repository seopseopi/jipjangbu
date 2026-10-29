import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("원문 보관 migration은 기존 엑셀 원문을 공백까지 보존하고 빈 tombstone은 다시 채우지 않는다", t => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const directory = new URL("../drizzle/", import.meta.url);
  const migrations = readdirSync(directory).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
  for (const name of migrations.filter(name => !name.startsWith("0007_")))
    sqlite.exec(readFileSync(new URL(name, directory), "utf8"));
  const source = "  합성 엑셀 원문\n둘째 줄  ";
  sqlite.prepare(`INSERT INTO listings(id,identity_key,status,property_type,building_name,source_notes)
    VALUES ('legacy','아파트|합성단지||101','매물등록','아파트','합성단지',?)`).run(source);
  const migration = readFileSync(new URL("0007_preserve_listing_sources.sql", directory), "utf8");
  sqlite.exec(migration);
  const key = "아파트|합성단지||101";
  assert.equal(sqlite.prepare("SELECT source_notes FROM listing_source_notes WHERE identity_key=?").get(key).source_notes, source);
  sqlite.prepare("UPDATE listing_source_notes SET source_notes='' WHERE identity_key=?").run(key);
  sqlite.exec(`INSERT OR IGNORE INTO listing_source_notes(identity_key,source_notes)
    SELECT identity_key,source_notes FROM listings WHERE source_notes<>''`);
  assert.equal(sqlite.prepare("SELECT source_notes FROM listing_source_notes WHERE identity_key=?").get(key).source_notes, "");
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='idx_work_log_properties_source_log'").get());
  for (const invalid of ["not-json", "{}", "null", '"text"', "1"]) {
    assert.throws(() => sqlite.prepare("INSERT INTO listing_source_notes(identity_key,event_history) VALUES (?,?)").run(`invalid-${invalid}`, invalid));
    assert.throws(() => sqlite.prepare("UPDATE listing_source_notes SET event_history=? WHERE identity_key=?").run(invalid, key));
  }
  assert.equal(sqlite.prepare("SELECT event_history FROM listing_source_notes WHERE identity_key=?").get(key).event_history, "[]");
});
