import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { canAppendPage } from "../app/client-paging.ts";
import { resultPaginationHarness } from "./helpers/result-pagination.mjs";

const source = readFileSync(new URL("../app/work-manager.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("work-manager.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) { let found; function visit(node) { if (predicate(node)) found=node; ts.forEachChild(node,visit); } visit(ast); assert.ok(found); return found; }
function evaluate(code, env) { const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText; return new Function(...Object.keys(env),js+";return actual;")(...Object.values(env)); }
function declaration(name) {return find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast);}
function handler(name,env) {return evaluate(declaration(name)+"\nconst actual="+name+";",env);}
function state(current) {const box={current};box.set=v=>{box.current=typeof v==="function"?v(box.current):v;};return box;}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function descendants(element) { return React.isValidElement(element) ? [element, ...React.Children.toArray(element.props.children).flatMap(descendants)] : []; }
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

function moreHarness(overrides = {}) {
  const pages=state({customers:{total:1201,hasMore:true,loadingMore:false,moreError:""},listings:{total:1201,hasMore:true,loadingMore:false,moreError:""}});
  const customers=state(records.slice(0,100)),listings=state(records.slice(0,100)),version={current:{customers:0,listings:0}},pending={current:{customers:false,listings:false}},controllers={current:{}};
  const response=deferred(),calls=[];
  const load=handler("loadMoreManaged",{
    listingQueryKey:"L",customerQueryKey:"C",listingStatus:"ready",customerStatus:"ready",managedPages:pages.current,
    managedReads:{customers:{loadedQuery:"C"},listings:{loadedQuery:"L"}},managedFirstPending:{current:{customers:null,listings:null}},managedMorePending:pending,managedMoreControllers:controllers,
    customersSearch:"",listingsSearch:"",customerResults:customers.current,listings:listings.current,MANAGEMENT_PAGE_SIZE:100,canAppendPage,
    managedQueryParams:()=>new URLSearchParams({q:"same-query"}),requestVersion:version,setManagedPages:pages.set,
    jsonFetch:(url,options)=>{calls.push({url,options});return response.promise;},setCustomerResults:customers.set,setListings:listings.set,appendManagedRows:append,isAborted:e=>e?.name==="AbortError",...overrides
  });
  return {load,pages,customers,listings,version,response,calls};
}

const loaderSource=readFileSync(new URL("../app/listing-scroll-loader.tsx",import.meta.url),"utf8");
const loaderAst=ts.createSourceFile("listing-scroll-loader.tsx",loaderSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const loaderNode=loaderAst.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="ListingScrollLoader");
assert.ok(loaderNode);
const ListingScrollLoader=evaluate(loaderNode.getText(loaderAst).replace(/^export /,"")+"\nconst actual=ListingScrollLoader;",{React,useRef:React.useRef,useEffect:React.useEffect});
const Listings=evaluate(["displayDate","targetText","statusTone","EmptyState","ListReadFeedback","Price","ListingsView"].map(declaration).join("\n")+"\nconst actual=ListingsView;",{
  React,ListingScrollLoader,Icon:()=>null,LISTING_WORK_TYPES:new Set(["매물등록","매물수정","가계약","잔금"]),
});
function listingView(network,extra={}) {
  return Listings({
    items:network.listings.current,...network.pages.current.listings,lookups:{propertyTypes:["아파트","빌라"]},
    query:"same-query",setQuery:()=>{},statuses:[],setStatuses:()=>{},prices:[],setPrices:()=>{},propertyType:"",setPropertyType:()=>{},
    sort:"type",setSort:()=>{},onReset:()=>{},onHistory:()=>{},status:"ready",onRetry:()=>{},canLoadMore:true,onLoadMore:()=>network.load("listings"),...extra,
  });
}
const listingRows=tree=>descendants(tree).filter(item=>item.props.className?.split(/\s+/).includes("table-row"));

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
  h.response.resolve({listings:records.slice(100,200),total:1201,hasMore:true});assert.equal(await first,200);
  assert.equal(h.listings.current.length,200);assert.equal(h.listings.current.at(-1).id,"synthetic-199");
  const shifted=moreHarness(),second=shifted.load("customers");
  shifted.response.resolve({customers:records.slice(99,199),total:1201,hasMore:true});await second;
  assert.equal(shifted.customers.current.length,100);assert.match(shifted.pages.current.customers.moreError,/목록이 변경/);
});

test("management page reads stay blocked while another condition or first-page request is pending",async()=>{
  for(const target of ["customers","listings"]){
    for(const overrides of [
      {[target==="customers"?"customerStatus":"listingStatus"]:"refreshing"},
      {managedReads:{customers:{loadedQuery:"old"},listings:{loadedQuery:"old"}}},
      {managedFirstPending:{current:{customers:1,listings:1}}},
    ]){
      const h=moreHarness(overrides);assert.equal(await h.load(target),undefined);
      assert.equal(h.calls.length,0);assert.equal(h[target].current.length,100);
    }
  }
});

test("the scrolling listing view shows every loaded row before and after appending the next server window",async()=>{
  const network=moreHarness(),opened=[];
  const first=listingView(network,{onHistory:item=>opened.push(item)});
  assert.equal(listingRows(first).length,100);
  assert.doesNotMatch(renderToStaticMarkup(first),/renewal-pagination|다음 페이지|이전 페이지|100건 더 보기/);
  const loader=descendants(first).find(item=>item.type===ListingScrollLoader);
  assert.deepEqual([loader.props.loaded,loader.props.hasMore,loader.props.enabled],[100,true,true]);
  const next=loader.props.onLoadMore();
  assert.equal(network.calls.length,1);
  assert.equal(new URL(network.calls[0].url,"https://local.invalid").searchParams.get("offset"),"100");
  network.response.resolve({listings:records.slice(100,200),total:1201,hasMore:true});
  await next;
  const appended=listingView(network,{onHistory:item=>opened.push(item)}),rows=listingRows(appended);
  assert.equal(rows.length,200,"all earlier rows remain on the same document instead of a local page slice");
  for(const row of rows)row.props.onClick();
  assert.deepEqual(opened,records.slice(0,200),"each displayed row still opens its original listing");
  assert.match(renderToStaticMarkup(appended),/200 \/ 1,201건/);
  assert.equal(network.calls.length,1,"rendering the full loaded range does not eagerly fetch every remaining record");
});

test("a failed scroll read preserves every loaded row, stops automatic loading and keeps the parent retry reachable",async()=>{
  const network=moreHarness(),next=network.load("listings");
  network.response.reject(Error("synthetic next page failed"));
  await next;
  assert.equal(network.listings.current.length,100);
  assert.match(network.pages.current.listings.moreError,/synthetic next page failed/);
  assert.equal(network.pages.current.listings.loadingMore,false);
  let retries=0;
  const tree=listingView(network,{onRetry:()=>retries++});
  assert.equal(listingRows(tree).length,100);
  const loader=descendants(tree).find(item=>item.type===ListingScrollLoader);
  assert.match(loader.props.error,/synthetic next page failed/);
  assert.equal(loader.props.busy,false);
  const retry=descendants(tree).find(item=>item.type==="button"&&renderToStaticMarkup(item).includes("최신 목록 다시 불러오기"));
  retry.props.onClick();
  assert.equal(retries,1);
  assert.match(renderToStaticMarkup(tree),/role="alert"/);
});

test("the final scroll window remains fully readable and hasMore=false blocks another network request",async()=>{
  const network=moreHarness(),next=network.load("listings");
  network.response.resolve({listings:records.slice(100,137),total:137,hasMore:false});
  await next;
  const tree=listingView(network),loader=descendants(tree).find(item=>item.type===ListingScrollLoader);
  assert.equal(listingRows(tree).length,137);
  assert.deepEqual([loader.props.loaded,loader.props.hasMore],[137,false]);
  assert.match(renderToStaticMarkup(tree),/137 \/ 137건/);
  const complete=moreHarness({managedPages:network.pages.current});
  assert.equal(await complete.load("listings"),undefined);
  assert.equal(complete.calls.length,0);
});

test("deleting the final page clamps it permanently and navigation scrolls the list without disturbing refreshes",async()=>{
  const h=resultPaginationHarness(),scrolls=[];
  let loaded=32,total=32;
  const render=()=>h.render(()=>{
    const paging=h.useResultPage(loaded,total,"same-query",10);
    return {...paging,listRef:h.useResultListRef(paging.page,"same-query")};
  });
  let paging=render();
  paging.listRef.current={scrollTo:value=>scrolls.push(value)};
  for(let page=1;page<=3;page++){await paging.next();paging=render();}
  assert.equal(paging.page,3);assert.equal(scrolls.length,3);
  render();assert.equal(scrolls.length,3,"refreshing the same reading position must not jump to the top");
  loaded=12;total=12;paging=render();
  assert.deepEqual([paging.page,paging.start,paging.end],[1,10,12]);
  assert.deepEqual(scrolls.at(-1),{top:0});
  loaded=32;total=32;paging=render();
  assert.equal(paging.page,1,"later inserts cannot resurrect the removed final page selection");
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
