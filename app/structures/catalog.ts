import type { Catalog, PropertyRow } from "./contracts";

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
    name: c.name,
    address: c.address,
    properties: catalog.properties.filter(
      (p) => linked.get(p.identity_key)?.complex_id === c.id,
    ),
    units: catalog.units.filter((u) => u.complex_id === c.id),
  }));
  const pending = catalog.properties.filter((p) => !linked.get(p.identity_key));
  return [
    ...registered,
    ...[
      ...new Set([
        ...pending.map((p) => p.building_name),
        ...(catalog.managedBuildings ?? [])
          .map((b) => b.building_name)
          .filter((name) => !catalog.complexes.some((c) => c.name === name)),
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
