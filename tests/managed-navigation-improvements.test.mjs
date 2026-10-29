import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { canAppendPage, collectOffsetPages } from "../app/client-paging.ts";

const source = readFileSync(new URL("../app/work-manager.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("work-manager.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) { let found; function visit(node) { if (predicate(node)) found=node; ts.forEachChild(node,visit); } visit(ast); assert.ok(found); return found; }
function evaluate(code, env) { const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText; return new Function(...Object.keys(env),js+";return actual;")(...Object.values(env)); }
function declaration(name) {return find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast);}
function handler(name,env) {return evaluate(declaration(name)+"\nconst actual="+name+";",env);}
function state(current) {const box={current};box.set=v=>{box.current=typeof v==="function"?v(box.current):v;};return box;}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const append=handler("appendManagedRows",{});
const readWindow=handler("readManagedWindow",{MANAGEMENT_PAGE_SIZE:100,appendManagedRows:append});
const records=Array.from({length:1201},(_,i)=>({id:"synthetic-"+i,name:"고객"+i,notes:"메모",history_count:i,property_type:i%2?"빌라":"아파트",building_name:"단지"+i,status:"매물등록"}));

test("management first page stops at 100 and refresh preserves only the expanded range",async()=>{
  const calls=[];
  const read=async(offset,limit)=>{calls.push([offset,limit]);return {rows:records.slice(offset,offset+limit),total:records.length,hasMore:offset+limit<records.length};};
  const first=await readWindow(read);
  assert.equal(first.rows.length,100);assert.equal(first.total,1201);assert.equal(first.hasMore,true);assert.deepEqual(calls,[[0,100]]);
  calls.length=0;
  const expanded=await readWindow(read,250);
  assert.equal(expanded.rows.length,250);assert.deepEqual(calls,[[0,100],[100,100],[200,50]]);
  await assert.rejects(readWindow(async(offset,limit)=>{if(offset)throw Error("second page failed");return read(offset,limit);},200),/second page failed/);
  await assert.rejects(readWindow(async()=>({rows:records.slice(0,100),total:1201,hasMore:true}),200),/목록이 변경/);
});

function moreHarness() {
  const pages=state({customers:{total:1201,hasMore:true,loadingMore:false,moreError:""},listings:{total:1201,hasMore:true,loadingMore:false,moreError:""}});
  const customers=state(records.slice(0,100)),listings=state(records.slice(0,100)),version={current:{customers:0,listings:0}},pending={current:{customers:false,listings:false}},controllers={current:{}};
  const response=deferred(),calls=[];
  const load=handler("loadMoreManaged",{
    listingQueryKey:"L",customerQueryKey:"C",listingStatus:"ready",customerStatus:"ready",managedPages:pages.current,
    managedReads:{customers:{loadedQuery:"C"},listings:{loadedQuery:"L"}},managedFirstPending:{current:{customers:null,listings:null}},managedMorePending:pending,managedMoreControllers:controllers,
    customersSearch:"",listingsSearch:"",customerResults:customers.current,listings:listings.current,MANAGEMENT_PAGE_SIZE:100,canAppendPage,
    managedQueryParams:()=>new URLSearchParams({q:"same-query"}),requestVersion:version,setManagedPages:pages.set,
    jsonFetch:(url,options)=>{calls.push({url,options});return response.promise;},setCustomerResults:customers.set,setListings:listings.set,appendManagedRows:append,isAborted:e=>e?.name==="AbortError"
  });
  return {load,pages,customers,listings,version,response,calls};
}

test("management more rejects duplicate clicks and ignores an old response after query invalidation",async()=>{
  const h=moreHarness(),first=h.load("customers");
  await h.load("customers");assert.equal(h.calls.length,1);
  assert.equal(new URL(h.calls[0].url,"https://local.invalid").searchParams.get("offset"),"100");
  h.version.current.customers++;
  h.response.resolve({customers:records.slice(100,200),total:1201,hasMore:true});await first;
  assert.equal(h.customers.current.length,100);assert.equal(h.pages.current.customers.loadingMore,false);
});

test("management more appends one bounded page, but duplicate offsets keep prior rows with a retry error",async()=>{
  const h=moreHarness(),first=h.load("listings");
  h.response.resolve({listings:records.slice(100,200),total:1201,hasMore:true});await first;
  assert.equal(h.listings.current.length,200);assert.equal(h.listings.current.at(-1).id,"synthetic-199");
  const shifted=moreHarness(),second=shifted.load("customers");
  shifted.response.resolve({customers:records.slice(99,199),total:1201,hasMore:true});await second;
  assert.equal(shifted.customers.current.length,100);assert.match(shifted.pages.current.customers.moreError,/목록이 변경/);
});

function exportHarness(target,{failSecond=false}={}) {
  const captured=[],calls=[],notices=[],queries={customers:"합성",listings:"합성"};
  const exporting=state({customers:false,listings:false});
  const params=handler("managedQueryParams",{queries,customerSort:"name",listingSort:"type",listingStatuses:["매물등록"],listingPrices:["sale"],propertyTypeFilter:"아파트"});
  const run=handler("exportManaged",{
    customerStatus:"ready",listingStatus:"ready",customerQueryKey:"C",listingQueryKey:"L",managedPages:{customers:{total:1201},listings:{total:1201}},
    managedExportPending:{current:{customers:false,listings:false}},managedReads:{customers:{loadedQuery:"C"},listings:{loadedQuery:"L"}},managedFirstPending:{current:{customers:null,listings:null}},managedMorePending:{current:{customers:false,listings:false}},
    canAppendPage,setManagedExporting:exporting.set,managedQueryParams:params,setNotice:value=>notices.push(value),collectOffsetPages,seoulDate:()=>"2026-10-29",downloadCsv:(...args)=>captured.push(args),
    jsonFetch:async(url)=>{const p=new URL(url,"https://local.invalid").searchParams;calls.push(p);if(failSecond&&calls.length===2)throw Error("export second page failed");queries[target]="changed-after-first-request";const offset=Number(p.get("offset"));return {[target]:records.slice(offset,offset+Number(p.get("limit")))};}
  });
  return {run:()=>run(target),captured,calls,notices,exporting};
}

test("both management CSVs collect all 1201 sorted rows independently from 100 displayed rows and freeze the query",async()=>{
  for(const target of ["customers","listings"]){
    const h=exportHarness(target);await h.run();
    assert.equal(h.captured.length,1);assert.equal(h.captured[0][2].length,1201);
    assert.deepEqual(h.calls.map(p=>p.get("offset")),["0","1000"]);
    assert.ok(h.calls.every(p=>p.get("limit")==="1000"&&p.get("q")==="합성"));
    if(target==="customers") assert.deepEqual(h.captured[0][2].at(-1).slice(0,2),["고객1200","synthetic-1200"]);
    else assert.deepEqual(h.captured[0][2].at(-1).slice(1,3),["아파트","단지1200"]);
    assert.equal(h.exporting.current[target],false);
  }
});

test("a later CSV page failure never downloads a partial file",async()=>{
  const h=exportHarness("customers",{failSecond:true});await h.run();
  assert.deepEqual(h.captured,[]);assert.match(h.notices.at(-1),/CSV를 저장하지 못했습니다.*second page failed/);assert.equal(h.exporting.current.customers,false);
});

test("popstate restores customer and listing records, then back cancels a pending restoration without another push",()=>{
  const node=find(n=>ts.isVariableDeclaration(n)&&n.name.getText(ast)==="syncView");
  const record=state(null),currentRecordKey={current:null},restores=[],version={current:0};
  const history={state:null,pushState:()=>assert.fail("restoring a history entry must not push another entry")};
  const restoreNode=find(n=>ts.isBinaryExpression(n)&&n.left.getText(ast)==="restoreRecord.current");
  const restore= evaluate("const actual="+restoreNode.right.getText(ast),{
    showCustomerHistory:({id,name})=>{restores.push(["customer",id]);record.set({customer:{id,name},items:[],loading:true});},
    showListingByKey:key=>{restores.push(["listing",key]);record.set({listingKey:key,items:[],loading:true});}
  });
  const sync=evaluate("const actual="+node.initializer.getText(ast),{
    navItems:[["today"],["customers"]],currentView:{current:"today"},currentRecordKey,restoreRecord:{current:restore},
    followUpBusy:{current:false},workBusy:{current:false},customerBusy:{current:false},followUpDirty:{current:false},
    workOpenVersion:{current:0},workReadVersion:{current:0},setWorkOpening:()=>{},setWorkReader:()=>{},setReaderReference:()=>{},historyOpenVersion:version,setHistoryModal:record.set,isRecordHistory:d=>!!(d.customer||d.listingKey),
    setView:()=>{},setNotice:()=>{},window:{location:{hash:"",pathname:"/"},history,confirm:()=>true}
  });
  history.state={record:"customer:customer:with-colon"};sync();assert.equal(record.current.customer.id,"customer:with-colon");currentRecordKey.current=history.state.record;
  history.state={record:"listing:아파트|합성|101|202"};sync();assert.equal(record.current.listingKey,"아파트|합성|101|202");currentRecordKey.current=history.state.record;
  history.state=null;sync();assert.equal(record.current,null);assert.equal(version.current,1);
  assert.deepEqual(restores,[["customer","customer:with-colon"],["listing","아파트|합성|101|202"]]);
});
