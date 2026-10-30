import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { DEMO_PLAN } from "../app/structures/plan.ts";
import { HILLSTATE_109_REFERENCE } from "../app/structures/hillstate-reference.ts";
const root = new URL("../", import.meta.url),
  symbol = Symbol.for("structure-test-db");
const hook = registerHooks({
  resolve(s, c, next) {
    if (s === "cloudflare:workers") return { url: 'data:text/javascript,export const env = {get BACKUPS(){return globalThis[Symbol.for("structure-test-bucket")]}}', shortCircuit:true };
    if (c.parentURL?.startsWith(root.href) && s.startsWith(".")) {
      const u = new URL(s, c.parentURL);
      if (u.href === new URL("db", root).href)
        return {
          url: 'data:text/javascript,export function getD1(){return globalThis[Symbol.for("structure-test-db")]}',
          shortCircuit: true,
        };
      if (u.href === new URL("db/bootstrap", root).href)
        return {
          url: "data:text/javascript,export async function ensureDatabase(){}",
          shortCircuit: true,
        };
      if (existsSync(`${u.pathname}.ts`))
        return { url: `${u.href}.ts`, shortCircuit: true };
    }
    return next(s, c);
  },
  load(u, c, next) {
    if (u.startsWith(root.href) && u.endsWith(".ts"))
      return {
        format: "module",
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(u), "utf8"), {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText,
      };
    return next(u, c);
  },
});
const api = await import("../app/api/structures/route.ts");
after(() => hook.deregister());
const filesApi = await import("../app/api/structures/files/[id]/route.ts");
function database(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("drizzle/", root);
  for (const f of readdirSync(dir)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort())
    db.exec(readFileSync(new URL(f, dir), "utf8"));
  globalThis[symbol] = {
    prepare(sql) {
      const q = db.prepare(sql);
      let values = [];
      const execute = () =>
        q.columns().length
          ? { success: true, results: q.all(...values) }
          : { success: true, results: [], meta: q.run(...values) };
      return {
        bind(...v) {
          values = v;
          return this;
        },
        async first() {
          return execute().results[0] ?? null;
        },
        async all() {
          return execute();
        },
        execute,
      };
    },
    async batch(statements) {
      db.exec("SAVEPOINT test");
      try {
        const results = statements.map((s) => s.execute());
        db.exec("RELEASE test");
        return results;
      } catch (e) {
        db.exec("ROLLBACK TO test; RELEASE test");
        throw e;
      }
    },
  };
  t.after(() => {
    db.close();
    delete globalThis[symbol];
  });
  return db;
}
const post = (body) =>
  api.POST(
    new Request("https://test.invalid/api/structures", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
const revisionInput = () => ({
  action: "revision",
  complexName: "합성 테스트 단지",
  address: "합성 주소",
  typeName: "테스트A",
  source: "합성 테스트 근거",
  permissionEvidence: "자동 테스트",
  confirmed: true,
  variant: "base",
  plan: { ...structuredClone(DEMO_PLAN), isDemo: false },
});
function fileBucket(t) {
  const objects = new Map();
  const bucket = {
    async put(key, stream, options) {
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
      if (sha !== options.sha256) throw new Error("R2 checksum mismatch");
      objects.set(key, bytes); return { size: bytes.length };
    },
    async get(key) { const value = objects.get(key); return value ? { size: value.length, body: new Blob([value]).stream() } : null; },
    async delete(key) { objects.delete(key); },
  };
  globalThis[Symbol.for("structure-test-bucket")] = bucket;
  t.after(() => delete globalThis[Symbol.for("structure-test-bucket")]);
  return { objects, bucket };
}
async function filePost(bytes, type = "application/pdf", headers = {}, metadata = {}) {
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
  return api.POST(new Request("https://test.invalid/api/structures", { method: "POST", headers: {
    "Content-Type": type, "X-File-Size": String(bytes.length), "X-File-SHA256": sha,
    "X-File-Name": encodeURIComponent(type === "application/pdf" ? "합성 도면.pdf" : "합성 도면.png"),
    "X-Structure-Metadata": encodeURIComponent(JSON.stringify({ ...revisionInput(), plan: undefined, ...metadata })), ...headers,
  }, body: bytes }));
}

test("PDF·PNG 원본을 등록하고 geometry 없이 버전·세대에 연결하며 원본을 조회한다", async t => {
  const db = database(t), { objects } = fileBucket(t);
  const fixtures = [[new TextEncoder().encode("%PDF-1.4\nsynthetic-file"), "application/pdf"], [Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1UAAAAASUVORK5CYII=", "base64")), "image/png"]];
  for (const [bytes, type] of fixtures) {
    const response = await filePost(bytes, type);
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
    const { id } = await response.json();
    const detail = await (await api.GET(new Request(`https://test.invalid/api/structures?revision=${id}`))).json();
    assert.equal(detail.plan, null); assert.equal(detail.file.mime_type, type); assert.equal(detail.file.byte_size, bytes.length);
    assert.equal("storage_key" in detail.file, false);
    const downloaded = await filesApi.GET(new Request("https://test.invalid/api/structures/files/x?download=1"), { params: Promise.resolve({ id }) });
    assert.equal(downloaded.status, 200); assert.equal(downloaded.headers.get("content-type"), type);
    assert.match(downloaded.headers.get("content-disposition"), /^attachment;/);
    assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), bytes);
    const assigned = await post({ action: "assign", revisionId: id, dong: "합성동", number: id, floor: null, mirror: null, rotation: null, actualCondition: "unknown", evidence: "합성 연결 근거", confirmed: true, expectedVersion: 0 });
    assert.equal(assigned.status, 201);
  }
  assert.equal(objects.size, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM structure_plan_files").get().n, 2);
});

test("위장 파일·초과 크기·전송 길이·체크섬 오류는 DB와 R2에 도면을 남기지 않는다", async t => {
  const db = database(t), { objects } = fileBucket(t);
  const bytes = new TextEncoder().encode("%PDF-1.4\nsynthetic-file");
  for (const [body, type, headers] of [
    [new TextEncoder().encode("<script>not pdf</script>"), "application/pdf", {}],
    [bytes, "application/pdf", { "X-File-Size": "33554433" }],
    [bytes, "application/pdf", { "X-File-Size": String(bytes.length + 1) }],
    [bytes, "application/pdf", { "X-File-Size": String(bytes.length - 1) }],
    [bytes, "application/pdf", { "X-File-SHA256": "0".repeat(64) }],
    [bytes, "application/pdf", { "X-File-Name": "../bad.pdf" }],
  ]) assert.equal((await filePost(body, type, headers)).status, 422);
  assert.equal((await filePost(bytes, "application/pdf", {}, { permissionEvidence: "" })).status, 422);
  assert.equal(objects.size, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM structure_plan_revisions").get().n, 0);
});

test("파일 저장 후 DB 실패는 원본 업로드를 정리하고 기존 도면은 보존한다", async t => {
  const db = database(t), { objects } = fileBucket(t);
  const first = await post(revisionInput()); assert.equal(first.status, 201);
  db.exec("CREATE TRIGGER fail_file BEFORE INSERT ON structure_plan_files BEGIN SELECT RAISE(ABORT,'test file insert failure'); END");
  assert.equal((await filePost(new TextEncoder().encode("%PDF-1.4\nsynthetic-file"))).status, 422);
  assert.equal(objects.size, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM structure_plan_revisions").get().n, 1);
});

test("R2가 파일 읽기 전에 실패해도 전송이 멈추지 않고 DB를 보존한다", { timeout: 2000 }, async t => {
  const db = database(t), { bucket } = fileBucket(t);
  bucket.put = async () => { throw new Error("synthetic storage outage"); };
  assert.equal((await filePost(new TextEncoder().encode("%PDF-1.4\nsynthetic-file"))).status, 422);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM structure_plan_files").get().n, 0);
});
test("도면 등록은 근거·동의가 필요하고 데모를 실단지에 연결하지 않는다", async (t) => {
  const db = database(t);
  for (const value of [
    { ...revisionInput(), plan: DEMO_PLAN },
    { ...revisionInput(), plan: HILLSTATE_109_REFERENCE },
    { ...revisionInput(), confirmed: false },
    { ...revisionInput(), permissionEvidence: "" },
  ])
    assert.equal((await post(value)).status, 422);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM structure_complexes").get().n,
    0,
  );
});
test("새 버전을 등록해도 기존 세대는 이전 버전에 고정되며 stale 수정은 거절된다", async (t) => {
  const db = database(t),
    first = await post(revisionInput());
  assert.equal(first.status, 201);
  const a = await first.json();
  const assign = {
    action: "assign",
    revisionId: a.id,
    dong: "테스트동",
    number: "테스트호",
    floor: "",
    mirror: null,
    rotation: null,
    actualCondition: "unknown",
    evidence: "합성 확인",
    confirmed: true,
    expectedVersion: 0,
  };
  const response = await post(assign);
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const second = await post({ ...revisionInput(), complexId: a.complexId });
  assert.equal(second.status, 201);
  const b = await second.json();
  assert.equal(
    db
      .prepare("SELECT revision_id FROM structure_assignments WHERE unit_id=?")
      .get(id).revision_id,
    a.id,
  );
  assert.equal((await post({ ...assign, revisionId: b.id })).status, 409);
  assert.equal(
    (await post({ ...assign, revisionId: b.id, expectedVersion: 1 })).status,
    201,
  );
  assert.equal(
    db
      .prepare("SELECT revision_id FROM structure_assignments WHERE unit_id=?")
      .get(id).revision_id,
    b.id,
  );
  assert.equal(
    db.prepare("SELECT floor FROM structure_units WHERE id=?").get(id).floor,
    null,
  );
  const detail = await api.GET(
    new Request(`https://test.invalid/api/structures?revision=${a.id}`),
  );
  assert.equal((await detail.json()).plan.rooms.length, 5);
});
test("방문 기록만 있는 물건도 탐색 가능하며 매물 projection 삭제로 구조 연결이 사라지지 않는다", async (t) => {
  const db = database(t);
  db.exec(
    "INSERT INTO customers(id,name) VALUES('c','합성고객'); INSERT INTO work_logs(id,work_date,customer_id,work_type) VALUES('w','2026-09-17','c','집방문'); INSERT INTO work_log_properties(id,work_log_id,sequence,property_type,building_name,building_dong,unit_number) VALUES('p','w',1,'아파트','합성단지','101','101');",
  );
  const catalog = await (
    await api.GET(new Request("https://test.invalid/api/structures"))
  ).json();
  assert.equal(catalog.properties.length, 1);
  assert.equal(catalog.properties[0].listing_count, 0);
  const a = await (await post(revisionInput())).json();
  const assign = {
    action: "assign",
    revisionId: a.id,
    dong: "101",
    number: "101",
    floor: null,
    mirror: null,
    rotation: null,
    actualCondition: "unknown",
    evidence: "확인",
    confirmed: true,
    expectedVersion: 0,
    identityKey: "아파트|합성단지|101|101",
  };
  assert.equal((await post(assign)).status, 201);
  assert.equal((await post({ ...assign, number: "102" })).status, 409);
  db.exec("DELETE FROM listings");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM structure_listing_links").get().n,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM structure_units").get().n,
    1,
  );
});

test("가공 영역과 2D·3D 구조를 저장·조회하고 충돌·위장 데이터는 차단한다", async t => {
 const db=database(t);fileBucket(t);
 const upload=await filePost(new TextEncoder().encode('%PDF-1.4\nprocessing-test'));
 const {id}=await upload.json();
 const processing={page:7,crop:{x:.1,y:.2,width:.7,height:.6},plan:revisionInput().plan,note:'합성 원본 추적 시험'};
 const input={action:'process',revisionId:id,confirmed:true,expectedVersion:0,processing};
 assert.equal((await post(input)).status,200);
 const detail=await (await api.GET(new Request(`https://test.invalid/api/structures?revision=${id}`))).json();
 assert.deepEqual(detail.processing.crop,processing.crop);assert.equal(detail.processing.rowVersion,1);assert.ok(detail.processing.plan.walls.length);
 assert.equal(detail.plan,null);assert.ok(detail.file); // original untouched
 assert.equal((await post(input)).status,409);
 assert.equal((await post({...input,expectedVersion:1,processing:{...processing,crop:{x:.8,y:0,width:.5,height:1}}})).status,422);
 assert.equal((await post({...input,expectedVersion:1,processing:{...processing,plan:DEMO_PLAN}})).status,422);
 assert.equal((await post({...input,expectedVersion:1,processing:{...processing,plan:null}})).status,200);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM structure_audit WHERE action='processing.saved'").get().n,2);
});

const sourceImageApi = await import('../app/api/structures/source-image/route.ts');
test('외부 도면 조회는 수집한 주소만 허용하고 리다이렉트·위장 이미지·과대 응답을 거절한다',async t=>{
 const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
 let called=0;
 globalThis.fetch=async()=>{called++;return new Response(Uint8Array.from([255,216,255,1,2,3,4,5]),{headers:{'Content-Type':'image/jpeg'}});};
 const url='https://test.invalid/api/structures/source-image?alias='+encodeURIComponent('힐스테이트1차')+'&type=62353&variant=base';
 assert.equal((await sourceImageApi.GET(new Request(url))).status,200);
 assert.equal((await sourceImageApi.GET(new Request('https://test.invalid/api/structures/source-image?url=https://evil.invalid'))).status,404);
 assert.equal(called,1);
 globalThis.fetch=async()=>new Response(null,{status:302,headers:{Location:'https://evil.invalid'}});
 assert.equal((await sourceImageApi.GET(new Request(url))).status,502);
 globalThis.fetch=async()=>new Response('<script>x</script>',{headers:{'Content-Type':'image/jpeg'}});
 assert.equal((await sourceImageApi.GET(new Request(url))).status,502);
 globalThis.fetch=async()=>new Response(new Uint8Array(8*1024*1024+1),{headers:{'Content-Type':'image/png'}});
 assert.equal((await sourceImageApi.GET(new Request(url))).status,502);
});
