import { getD1 } from ".";

export type PropertyInput = {
  propertyType?: string;
  buildingName?: string;
  buildingDong?: string;
  unitNumber?: string;
  sizeType?: string;
  salePrice?: string;
  jeonsePrice?: string;
  monthlyRent?: string;
  source?: string;
};

export { LISTING_WORK_TYPES } from "../app/listing-work-types.js";

export function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

export function listingKey(detail: PropertyInput): string {
  return [detail.propertyType, detail.buildingName, detail.buildingDong, detail.unitNumber]
    .map((value) => clean(value).toLocaleLowerCase("ko-KR"))
    .join("|");
}

export function isPropertyComplete(detail: PropertyInput): boolean {
  return Boolean(clean(detail.propertyType) && clean(detail.buildingName) && (clean(detail.propertyType) === "토지" || clean(detail.unitNumber)));
}

// The work, its events, and the current listing are one durable change. Return
// SQL instead of reading events here so callers can append these projections to
// the same D1 batch, after the event mutations. All reads below therefore see
// the newly saved events and a failure rolls the entire user action back.
export function listingRebuildStatements(keys: Iterable<string>, db: D1Database = getD1()) {
  const statements: D1PreparedStatement[] = [];
  for (const key of new Set([...keys].filter(Boolean))) {
    statements.push(db.prepare(`
      DELETE FROM listings
      WHERE identity_key = ?
        AND NOT EXISTS (SELECT 1 FROM listing_events WHERE listing_key = ?)
    `).bind(key, key));
    statements.push(db.prepare(`
      WITH ordered_events AS (
        SELECT * FROM listing_events
        WHERE listing_key = ?
        ORDER BY event_date DESC, event_order DESC, created_at DESC, id DESC
      ), latest AS (
        SELECT * FROM ordered_events LIMIT 1
      ), summary AS (
        SELECT MIN(CASE WHEN status = '매물등록' THEN event_date END) AS registered_at,
          GROUP_CONCAT(TRIM(COALESCE(notes, '') || ' (' || status || ') (' || event_date || ')'), char(10)) AS event_notes
        FROM ordered_events
      )
      INSERT INTO listings (
        id, identity_key, registered_at, closed_at, status, property_type, building_name,
        building_dong, unit_number, size_type, sale_price, jeonse_price, monthly_rent,
        notes, source_notes, is_demo, updated_at
      )
      SELECT ?, latest.listing_key, COALESCE(summary.registered_at, latest.event_date),
        CASE WHEN latest.status IN ('매물등록', '매물수정') THEN NULL ELSE latest.event_date END,
        latest.status, latest.property_type, latest.building_name, latest.building_dong,
        latest.unit_number, latest.size_type, latest.sale_price, latest.jeonse_price, latest.monthly_rent,
        CASE WHEN COALESCE(previous.source_notes, '') = '' THEN COALESCE(summary.event_notes, '')
          WHEN COALESCE(summary.event_notes, '') = '' THEN previous.source_notes
          ELSE previous.source_notes || char(10) || summary.event_notes END,
        COALESCE(previous.source_notes, ''), latest.is_demo, CURRENT_TIMESTAMP
      FROM latest CROSS JOIN summary
      LEFT JOIN listings previous ON previous.identity_key = latest.listing_key
      WHERE 1
      ON CONFLICT(identity_key) DO UPDATE SET
        registered_at = excluded.registered_at,
        closed_at = excluded.closed_at,
        status = excluded.status,
        property_type = excluded.property_type,
        building_name = excluded.building_name,
        building_dong = excluded.building_dong,
        unit_number = excluded.unit_number,
        size_type = excluded.size_type,
        sale_price = excluded.sale_price,
        jeonse_price = excluded.jeonse_price,
        monthly_rent = excluded.monthly_rent,
        notes = excluded.notes,
        source_notes = excluded.source_notes,
        is_demo = excluded.is_demo,
        updated_at = CURRENT_TIMESTAMP
    `).bind(key, crypto.randomUUID()));
  }
  return statements;
}

export async function rebuildListings(keys: Iterable<string>) {
  const statements = listingRebuildStatements(keys);
  if (statements.length) await getD1().batch(statements);
}
