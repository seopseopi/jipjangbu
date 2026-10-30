import sources from "./apartment-sources.json" with { type: "json" };
import buildingTypes from "./apartment-building-types.json" with { type: "json" };
export type SourceType = {
  id: string;
  label: string;
  supplyArea: string;
  exclusiveArea: string | null;
  rooms: number | null;
  bathrooms: number | null;
  households: number | null;
  basicImage: string | null;
  expandedImage: string | null;
  sourceUrl: string;
};
export type ApartmentSource = {
  alias: string;
  name: string;
  address: string;
  sourceUrl: string;
  checkedAt: string;
  types: SourceType[];
  status: string;
  note: string;
};
export const APARTMENT_SOURCES = sources as ApartmentSource[];
export const APARTMENT_BUILDING_TYPES = buildingTypes;
export function apartmentSources(name: string) {
  return APARTMENT_SOURCES.filter(
    (s) =>
      s.alias === name ||
      s.name === name ||
      (name === "우방1차(금곡동)" && s.alias === "우방1차"),
  );
}
export function sourceImageUrl(alias: string, typeId: string, variant: string) {
  const source = APARTMENT_SOURCES.find((s) => s.alias === alias),
    type = source?.types.find((t) => t.id === typeId);
  const url =
    variant === "base"
      ? type?.basicImage
      : variant === "expanded"
        ? type?.expandedImage
        : null;
  // Sources are checked-in metadata, never client URLs. No network destination is accepted from a request.
  return url?.startsWith("https://file.kbland.kr/image/") ? url : null;
}

// Building/type metadata narrows candidates, never verifies a particular unit's
// orientation, extensions, or alterations. Journal labels use both truncated and
// rounded pyeong; both are suggestions only and may leave multiple candidates.
export function sourceTypeCandidates(
  source: ApartmentSource,
  sizes: string,
  dong: string,
) {
  const normalizedDong = dong.trim().replace(/동$/, "").toUpperCase();
  const catalog = APARTMENT_BUILDING_TYPES.find(
    (entry) => entry.alias === source.alias && entry.sourceUrl === source.sourceUrl,
  );
  const building = catalog?.buildings.find(
    (entry) => entry.dong.toUpperCase() === normalizedDong,
  );
  if (normalizedDong && catalog && !building) return [];
  // The source page combines separately addressed complexes; the reviewed source
  // contains only first-complex candidates, whose official building is 201.
  if (source.alias === "미래지향" && normalizedDong && normalizedDong !== "201")
    return [];
  const labels = sizes
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return source.types.filter((t) =>
    (!building || building.typeIds.includes(t.id)) &&
    labels.some((label) => {
      const m = label.match(/^(\d+)([A-Z]?)$/);
      if (!m) return false;
      const suffix = t.label.match(/[A-Z](?=㎡)/)?.[0] ?? "";
      const pyeong = Number(t.supplyArea) / 3.305785;
      return (
        [Math.floor(pyeong), Math.round(pyeong)].includes(Number(m[1])) &&
        (!m[2] || m[2] === suffix)
      );
    }),
  );
}
