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
