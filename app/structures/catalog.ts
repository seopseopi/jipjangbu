import type { Catalog, PropertyRow, StructureUnit } from "./contracts";
import { apartmentSources, APARTMENT_SOURCES, sourceTypeCandidates } from "./source-contract.ts";

function knownComplex(catalog: Catalog, name: string) {
  const sources = apartmentSources(name);
  const matches = catalog.complexes.filter((c) => sources.some((s) => s.name === c.name && s.address === c.address));
  return matches.length === 1 ? matches[0] : undefined;
}
export function structureGroupKey(catalog: Catalog, property: PropertyRow) {
  const linked = linkedStructureUnit(catalog, property.identity_key);
  const id = linked?.complex_id ?? knownComplex(catalog, property.building_name)?.id;
  return id ? `complex:${id}` : `listing:${property.building_name}`;
}

export function linkedStructureUnit(catalog: Catalog, propertyKey: string) {
  return catalog.units.find(
    (u) =>
      u.id ===
      catalog.links.find((l) => l.identity_key === propertyKey)?.unit_id,
  );
}
export function structureGroups(catalog: Catalog) {
  const byId = new Map(catalog.units.map((u) => [u.id, u]));
  const linked = new Map(
    catalog.links.map((l) => [l.identity_key, byId.get(l.unit_id)]),
  );
  const registered = catalog.complexes.map((c) => ({
    key: `complex:${c.id}`,
    name: APARTMENT_SOURCES.find((s) => s.name === c.name && s.address === c.address)?.alias ?? c.name,
    address: c.address,
    properties: catalog.properties.filter(
      (p) => (linked.get(p.identity_key)?.complex_id ?? knownComplex(catalog, p.building_name)?.id) === c.id,
    ),
    units: catalog.units.filter((u) => u.complex_id === c.id),
  }));
  const pending = catalog.properties.filter((p) => !linked.get(p.identity_key) && !knownComplex(catalog, p.building_name));
  return [
    ...registered,
    ...[
      ...new Set([
        ...pending.map((p) => p.building_name),
        ...(catalog.managedBuildings ?? [])
          .map((b) => b.building_name)
          .filter((name) => !catalog.complexes.some((c) => c.name === name) && !knownComplex(catalog, name)),
      ]),
    ].map((name) => ({
      key: `listing:${name}`,
      name,
      address: "장부명 · 공식 단지 연결 전",
      properties: pending.filter((p) => p.building_name === name),
      units: [] as Catalog["units"],
    })),
  ];
}
export function structurePropertyDong(catalog: Catalog, property: PropertyRow) {
  return (
    linkedStructureUnit(catalog, property.identity_key)?.building_name ??
    property.building_dong
  );
}

/** Recheck current journal identity and type before displaying a saved link.
 * Historical size labels and unknown household alterations never become proof. */
export function structureConnectionIssue(catalog: Catalog, property: PropertyRow | undefined, unit: StructureUnit | undefined) {
  if(!property || !unit)return "";
  const normalize=(s:string,suffix:string)=>s.trim().replace(new RegExp(`${suffix}$`),"");
  if(normalize(property.building_dong,"동")!==normalize(unit.building_name,"동") ||
    normalize(property.unit_number,"호")!==normalize(unit.number,"호"))
    return "장부 동·호수와 연결된 도면이 다릅니다. 연결을 확인해 주세요.";
  const complex=catalog.complexes.find(c=>c.id===unit.complex_id);
  const sources=apartmentSources(property.building_name);
  const source=sources.find(s=>s.name===complex?.name && s.address===complex.address);
  if(sources.length && !source)return "장부 단지와 연결된 도면의 단지가 다릅니다. 연결을 확인해 주세요.";
  const revision=catalog.revisions.find(r=>r.id===unit.revision_id);
  if(!source || !revision || !property.current_size_type?.trim())return "";
  const type=source.types.find(t=>t.label===revision.type_name);
  if(!type)return ""; // Manually supplied models use their own reviewed source.
  const labels=property.current_size_type.split(",").map(s=>s.trim()).filter(Boolean);
  if(labels.some(label=>{
    const matches=sourceTypeCandidates(source,label,property.building_dong);
    return !matches.some(t=>t.id===type.id);
  }))return "최신 장부 평형과 연결된 도면이 다릅니다. 타입을 확인해 주세요.";
  return "";
}
