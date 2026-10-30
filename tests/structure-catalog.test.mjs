import test from "node:test";
import assert from "node:assert/strict";
import { structureGroups, structurePropertyDong } from "../app/structures/catalog.ts";

test("같은 단지 이름의 서로 다른 주소는 ID별로 나누고 미연결 장부는 추정 병합하지 않는다", () => {
  const data = { complexes: [{ id: "a", name: "동명아파트", address: "주소A" }, { id: "b", name: "동명아파트", address: "주소B" }],
    properties: [{ identity_key: "a1", building_name: "장부 별칭", building_dong: "1" }, { identity_key: "pending", building_name: "동명아파트", building_dong: "1" }],
    units: [{ id: "ua", complex_id: "a", building_name: "확인동" }, { id: "ub", complex_id: "b", building_name: "확인동" }], links: [{ identity_key: "a1", unit_id: "ua" }], revisions: [] };
  const groups = structureGroups(data);
  assert.deepEqual(groups.map(g => g.key), ["complex:a", "complex:b", "listing:동명아파트"]);
  assert.deepEqual(groups.map(g => g.properties.map(p => p.identity_key)), [["a1"], [], ["pending"]]);
  assert.equal(structurePropertyDong(data, data.properties[0]), "확인동");
});

test("누락된 세대를 가리키는 연결은 확인된 단지로 승격하지 않는다", () => {
  const data = { complexes: [{ id: "a", name: "단지", address: "주소" }], properties: [{ identity_key: "x", building_name: "단지", building_dong: "1" }], units: [], links: [{ identity_key: "x", unit_id: "missing" }], revisions: [] };
  assert.equal(structureGroups(data).find(g => g.key === "listing:단지").properties.length, 1);
});

test("업무 기록이 없는 관리 아파트도 전체 도면 수집 목록에 나타난다",()=>{
 const data={properties:[],complexes:[],units:[],revisions:[],links:[],managedBuildings:[{id:'managed',building_name:'아파트A'}]};
 assert.equal(structureGroups(data)[0].name,'아파트A');assert.equal(structureGroups(data)[0].properties.length,0);
});

test('공식 이름·주소가 일치하는 등록 단지는 장부 별칭과 연결 대기 매물을 한 목록으로 표시한다',()=>{
 const data={complexes:[{id:'real',name:'검단아이파크',address:'인천광역시 검단구 완정로92번길 28'}],units:[],revisions:[],links:[],managedBuildings:[{id:'lookup',building_name:'아이파크1차'}],properties:[{identity_key:'pending',building_name:'아이파크1차',building_dong:'107',unit_number:'601'}]};
 const groups=structureGroups(data);assert.equal(groups.length,1);assert.equal(groups[0].name,'아이파크1차');assert.equal(groups[0].properties[0].identity_key,'pending');
 const wrongAddress={...data,complexes:[{...data.complexes[0],address:'다른 주소'}]};
 assert.equal(structureGroups(wrongAddress).length,2);
});

test('저장한 도면도 최신 동호수·단지·평형 충돌이면 표시 전에 감지한다',async()=>{
 const {structureConnectionIssue}=await import('../app/structures/catalog.ts');
 const {APARTMENT_SOURCES}=await import('../app/structures/source-contract.ts');
 const source=APARTMENT_SOURCES.find(s=>s.alias==='아이파크1차'),type=source.types.find(t=>t.id==='62354');
 const property={identity_key:'synthetic',building_name:source.alias,building_dong:'101동',unit_number:'9001호',current_size_type:'33',size_types:'33,45'};
 const unit={id:'u',complex_id:'c',building_name:'101',number:'9001',revision_id:'r'};
 const catalog={complexes:[{id:'c',name:source.name,address:source.address}],revisions:[{id:'r',type_name:type.label}]};
 assert.equal(structureConnectionIssue(catalog,property,unit),'','과거의 다른 평형은 현재 충돌로 취급하지 않음');
 assert.match(structureConnectionIssue(catalog,{...property,current_size_type:'45'},unit),/최신 장부 평형/);
 assert.match(structureConnectionIssue(catalog,property,{...unit,number:'9002'}),/동·호수/);
 assert.match(structureConnectionIssue({...catalog,complexes:[{...catalog.complexes[0],address:'다른 단지'}]},property,unit),/단지/);
 assert.equal(structureConnectionIssue(catalog,undefined,unit),'');
});
