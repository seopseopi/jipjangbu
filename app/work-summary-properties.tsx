import { getWorkProperties, workPropertyLabel } from "./work-property-summary";
import { getPropertyDisplayGroups } from "./property-display";

type PropertyWork = Parameters<typeof getWorkProperties>[0] & { search_property_match?: number };

/** Read-only context shared by search, upcoming work, and inline customer history. */
export function WorkSummaryProperties({ work, showSingle = false, showPrices = false }: {
  work: PropertyWork;
  showSingle?: boolean;
  showPrices?: boolean;
}) {
  const properties = getWorkProperties(work);
  const count = Math.max(work.property_count || 0, properties.length);
  if (!properties.length || (!showSingle && count < 2)) return null;
  const groups = getPropertyDisplayGroups(properties);
  return (
    <span className="work-summary-properties" role="group" aria-label="함께 기록한 물건">
      {count > 1 && <span className="work-summary-property-count">함께 기록한 물건 {count}개</span>}
      <span className="work-summary-property-list" role="list">
        {groups.flatMap((group) => {
          const compactBuilding = Boolean(group.building && group.items.length > 1);
          const heading = compactBuilding ? <span className="work-summary-building" key={`building-${group.key}`} role="presentation">{group.building}</span> : null;
          const entries = group.items.map(({ property, index, shortLabel, sourceLabel }) => {
          const matched = work.search_property_match === 1 && ["property_type", "building_name", "building_dong", "unit_number"].every((field) => {
            const key = field as "property_type" | "building_name" | "building_dong" | "unit_number";
            return String(property[key] || "").trim() === String(work[key] || "").trim();
          });
          const prices = [property.sale_price && `매매 ${property.sale_price}`, property.jeonse_price && `전세 ${property.jeonse_price}`, property.monthly_rent && `월세 ${property.monthly_rent}`].filter(Boolean).join(" · ");
          const fullAddress = workPropertyLabel(property, true);
          const visibleAddress = compactBuilding ? `${shortLabel}${sourceLabel}` : fullAddress;
          const metadata = [showPrices && [property.property_type, property.size_type].filter(Boolean).join(" · "), showPrices && prices].filter(Boolean).join(" · ");
          return (
            <span className={`work-summary-property${matched ? " is-search-match" : ""}`} role="listitem" key={property.id || index} aria-label={`물건 ${index + 1} · ${fullAddress}`}>
              {count > 1 && <span className="work-summary-property-number" aria-hidden="true">{index + 1}.</span>}
              <span className="work-summary-property-copy">
                <span className="work-summary-property-line"><span className="work-summary-property-label" title={fullAddress}>{visibleAddress}</span>{matched && <span className="work-summary-property-match">검색 일치</span>}</span>
                {metadata && <span className="work-summary-property-meta">{metadata}</span>}
              </span>
            </span>
          );
          });
          return heading ? [heading, ...entries] : entries;
        })}
      </span>
      {count > properties.length && <span className="work-summary-property-meta">전체 물건 주소는 업무 내용을 열어 확인해 주세요.</span>}
    </span>
  );
}
