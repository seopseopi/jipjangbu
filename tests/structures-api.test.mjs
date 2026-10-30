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
  assert.equal((await filePost(bytes, "application/pdf", {}, { source: "" })).status, 422);
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
test("도면 등록의 필수 식별정보와 데모 연결 차단을 유지한다", async (t) => {
  const db = database(t);
  for (const value of [
    { ...revisionInput(), plan: DEMO_PLAN },
    { ...revisionInput(), plan: HILLSTATE_109_REFERENCE },
    { ...revisionInput(), confirmed: false },
    { ...revisionInput(), complexName: "" },
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

test('세대 연결은 추가 근거 입력 없이 저장하고 첫 연결부터 다른 동·호수는 차단한다', async t=>{
 const db=database(t);
 db.exec("INSERT INTO customers(id,name) VALUES('simple-c','합성'); INSERT INTO work_logs(id,work_date,customer_id,work_type) VALUES('simple-w','2026-10-30','simple-c','집방문'); INSERT INTO work_log_properties(id,work_log_id,sequence,property_type,building_name,building_dong,unit_number) VALUES('simple-p','simple-w',1,'아파트','합성단지','101','301');");
 const input=revisionInput();delete input.permissionEvidence;
 const r=await post(input);assert.equal(r.status,201);const {id}=await r.json();
 const assignment={action:'assign',revisionId:id,dong:'101',number:'302',mirror:false,rotation:0,actualCondition:'base',expectedVersion:0,confirmed:true,identityKey:'아파트|합성단지|101|301'};
 assert.equal((await post(assignment)).status,409);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM structure_units').get().n,0);
 assert.equal((await post({...assignment,dong:'101동',number:'301호'})).status,201);
 assert.equal(db.prepare('SELECT evidence FROM structure_assignments').get().evidence,'');
});

const {importPublicPlans,publicPlanCandidate,upgradePreparedPlans}=await import('../worker/structure-public-import.ts');
function importListing(db,{key='아파트|아이파크1차|101|9001',dong='101',size='33',closed=null,demo=0,unit='9001'}={}) {
 db.prepare(`INSERT INTO listings(id,identity_key,status,property_type,building_name,building_dong,unit_number,size_type,closed_at,is_demo)
 VALUES(?,?,'매물등록','아파트','아이파크1차',?,?,?,?,?)`).run(crypto.randomUUID(),key,dong,unit,size,closed,demo);
 return key;
}
async function importFixture() {
 const bytes=Uint8Array.from([255,216,255,0,1,2,3,4,5]);
 const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 const {APARTMENT_SOURCES}=await import('../app/structures/source-contract.ts');
 const type=APARTMENT_SOURCES.find(s=>s.alias==='아이파크1차').types.find(t=>t.id==='62354');
 const model={typeId:type.id,sourceImage:type.basicImage,sha256,crop:{x:0,y:0,width:1,height:1},plan:{...DEMO_PLAN,isDemo:false}};
 return {bytes,model,image:async()=>new Response(bytes,{headers:{'Content-Type':'image/jpeg'}})};
}
test('공개 도면 일괄 연결은 종료 매물도 포함하고 방향·확장을 미확인으로 보존하며 재실행해도 중복하지 않는다',async t=>{
 const sqlite=database(t),{bucket,objects}=fileBucket(t),f=await importFixture();
 importListing(sqlite);importListing(sqlite,{key:'아파트|아이파크1차|107|9001',dong:'107',size:'33'});
 importListing(sqlite,{key:'아파트|아이파크1차|102|9001',dong:'102',closed:'2026-01-01'});
 importListing(sqlite,{key:'아파트|아이파크1차|104|9001',dong:'104',demo:1});
 const result=await importPublicPlans(globalThis[symbol],bucket,f.image,[f.model]);
 assert.equal(result.linked,2);assert.equal(result.registered,1);assert.equal(result.skipped,1);assert.deepEqual(result.errors,[]);
 const assignment=sqlite.prepare('SELECT * FROM structure_assignments').get();
 assert.equal(assignment.mirror,null);assert.equal(assignment.rotation,null);assert.equal(assignment.actual_condition,'unknown');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM structure_plan_processing').get().n,1);assert.equal(objects.size,1);
 const again=await importPublicPlans(globalThis[symbol],bucket,f.image,[f.model]);
 assert.equal(again.linked,0);assert.equal(again.registered,0);assert.equal(objects.size,1);
 assert.equal(publicPlanCandidate({building_name:'아이파크2차',building_dong:'207',unit_number:'804',size_type:'48A',identity_key:'x'}).model.plan != null,true);
 assert.equal(publicPlanCandidate({building_name:'아이파크2차',building_dong:'207',unit_number:'804',size_type:'48A,48B',identity_key:'x'}),null);
 assert.equal(publicPlanCandidate({building_name:'아이파크1차',building_dong:'101',unit_number:'804',size_type:'33,45',identity_key:'x'}),null);
});
test('가공 원본 SHA 변경과 동호수 장부 변경을 감지하면 연결하지 않는다',async t=>{
 const sqlite=database(t),{bucket,objects}=fileBucket(t),f=await importFixture();
 importListing(sqlite);
 const bad=await importPublicPlans(globalThis[symbol],bucket,async()=>new Response(new Uint8Array([255,216,255,1,2,3,4,5]),{headers:{'Content-Type':'image/jpeg'}}),[f.model]);
 assert.equal(bad.linked,0);assert.equal(bad.errors.length,1);assert.equal(objects.size,0);
 const raced=await importPublicPlans(globalThis[symbol],bucket,async()=>{
  sqlite.prepare("UPDATE listings SET size_type='45'").run();return f.image();
 },[f.model]);
 assert.equal(raced.linked,0);assert.equal(raced.errors.length,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM structure_units').get().n,0);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM structure_listing_links').get().n,0);
});

test('전체 매물 연결은 배치 제한을 지키고 재실행할 때 다음 세대부터 중복 없이 이어진다',async t=>{
 const sqlite=database(t),{bucket,objects}=fileBucket(t),f=await importFixture();
 for(let i=1;i<=5;i++)importListing(sqlite,{key:`아파트|아이파크1차|101|${i}`,unit:String(i)});
 const first=await importPublicPlans(globalThis[symbol],bucket,f.image,[f.model],2);
 assert.equal(first.linked,2);assert.equal(first.remaining,3);
 const second=await importPublicPlans(globalThis[symbol],bucket,f.image,[f.model],2);
 assert.equal(second.linked,2);assert.equal(second.remaining,1);
 const last=await importPublicPlans(globalThis[symbol],bucket,f.image,[f.model],2);
 assert.equal(last.linked,1);assert.equal(last.remaining,0);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM structure_listing_links').get().n,5);assert.equal(objects.size,1);
});
test('기본형이 없는 타입은 확장형 원본 구분을 유지하고 미검토 3D를 만들지 않는다',async t=>{
 const sqlite=database(t),{bucket}=fileBucket(t),f=await importFixture();
 const {APARTMENT_SOURCES}=await import('../app/structures/source-contract.ts');
 const source=APARTMENT_SOURCES.find(s=>s.alias==='양우내안에'),type=source.types.find(t=>t.id==='1249443');
 sqlite.prepare(`INSERT INTO listings(id,identity_key,status,property_type,building_name,building_dong,unit_number,size_type,is_demo)
 VALUES('expanded-only','아파트|양우내안에|102|9001','매물등록','아파트','양우내안에','102','9001','28',0)`).run();
 const model={...f.model,typeId:type.id,variant:'expanded',sourceImage:type.expandedImage,plan:null};
 let requestedVariant='';const result=await importPublicPlans(globalThis[symbol],bucket,async(_s,_t,variant)=>{requestedVariant=variant;return f.image();},[model]);
 assert.equal(result.linked,1);assert.equal(requestedVariant,'expanded');
 assert.equal(sqlite.prepare('SELECT variant FROM structure_plan_revisions').get().variant,'expanded');
 assert.equal(JSON.parse(sqlite.prepare('SELECT processing_json FROM structure_plan_processing').get().processing_json).plan,null);
 assert.match(sqlite.prepare('SELECT evidence FROM structure_units').get().evidence,/장부 평형 기준/);
 assert.equal(sqlite.prepare('SELECT actual_condition FROM structure_assignments').get().actual_condition,'unknown');
});

test('원본만 있던 도면에 3D를 보강해도 동호수·배정·파일·편집된 크롭을 유지하고 재실행은 무변경이다',async t=>{
 const sqlite=database(t),{bucket}=fileBucket(t),f=await importFixture();
 importListing(sqlite);
 await importPublicPlans(globalThis[symbol],bucket,f.image,[{...f.model,plan:null}]);
 const links=sqlite.prepare('SELECT * FROM structure_listing_links').all();
 const assignments=sqlite.prepare('SELECT * FROM structure_assignments').all();
 const files=sqlite.prepare('SELECT * FROM structure_plan_files').all();
 const row=sqlite.prepare('SELECT * FROM structure_plan_processing').get();
 const custom={...JSON.parse(row.processing_json),crop:{x:.1,y:.1,width:.8,height:.8},note:'사용자 영역 편집'};
 sqlite.prepare('UPDATE structure_plan_processing SET processing_json=?,row_version=3').run(JSON.stringify(custom));
 const result=await upgradePreparedPlans(globalThis[symbol],[f.model]);
 assert.equal(result.modelled,1);assert.equal(result.remaining,0);assert.deepEqual(result.errors,[]);
 const updated=sqlite.prepare('SELECT * FROM structure_plan_processing').get(),processing=JSON.parse(updated.processing_json);
 assert.equal(updated.row_version,4);assert.deepEqual(processing.crop,custom.crop);assert.equal(processing.note,custom.note);assert.ok(processing.plan);
 assert.deepEqual(sqlite.prepare('SELECT * FROM structure_listing_links').all(),links);
 assert.deepEqual(sqlite.prepare('SELECT * FROM structure_assignments').all(),assignments);
 assert.deepEqual(sqlite.prepare('SELECT * FROM structure_plan_files').all(),files);
 assert.equal((await upgradePreparedPlans(globalThis[symbol],[f.model])).modelled,0);
 assert.deepEqual(sqlite.prepare('SELECT * FROM structure_plan_processing').get(),updated);
});
test('3D 보강은 원본 SHA·타입·variant가 정확히 일치해야 하며 동시 편집을 덮어쓰지 않는다',async t=>{
 const sqlite=database(t),{bucket}=fileBucket(t),f=await importFixture();importListing(sqlite);
 await importPublicPlans(globalThis[symbol],bucket,f.image,[{...f.model,plan:null}]);
 for(const model of [{...f.model,sha256:'wrong'},{...f.model,typeId:'wrong'},{...f.model,variant:'expanded'}])
  assert.equal((await upgradePreparedPlans(globalThis[symbol],[model])).modelled,0);
 const db=globalThis[symbol],batch=db.batch.bind(db);
 db.batch=async statements=>{
  sqlite.prepare('UPDATE structure_plan_processing SET row_version=row_version+1').run();return batch(statements);
 };
 const result=await upgradePreparedPlans(db,[f.model]);assert.equal(result.modelled,0);assert.equal(result.errors.length,1);
 assert.equal(JSON.parse(sqlite.prepare('SELECT processing_json FROM structure_plan_processing').get().processing_json).plan,null);
});
