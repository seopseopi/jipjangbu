import sources from "./apartment-sources.json" with { type: "json" };
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

// Candidates only: floor of published supply area in pyeong follows the journal's
// convention, but never becomes evidence of a unit's type or orientation.
export function sourceTypeCandidates(
  source: ApartmentSource,
  sizes: string,
  dong: string,
) {
  if (source.alias === "미래지향" && /^201(?:동)?$/.test(dong.trim()))
    return [];
  const labels = sizes
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return source.types.filter((t) =>
    labels.some((label) => {
      const m = label.match(/^(\d+)([A-Z]?)$/);
      if (!m) return false;
      const suffix = t.label.match(/[A-Z](?=㎡)/)?.[0] ?? "";
      return (
        Number(m[1]) === Math.floor(Number(t.supplyArea) / 3.305785) &&
        (!m[2] || m[2] === suffix)
      );
    }),
  );
}
