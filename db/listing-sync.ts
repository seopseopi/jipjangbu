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

export function hasListingKeyDelimiter(detail: PropertyInput): boolean {
  return [detail.propertyType, detail.buildingName, detail.buildingDong, detail.unitNumber]
    .some((value) => clean(value).includes("|"));
}

export function isPropertyComplete(detail: PropertyInput): boolean {
  return Boolean(clean(detail.propertyType) && clean(detail.buildingName) && (clean(detail.propertyType) === "토지" || clean(detail.unitNumber)));
}

// Original spreadsheet notes outlive the derived current-listing row. Empty
// values are intentional tombstones after pruning, never a reason to fall back
// to an older copy from a deleted listing or another pending trash record.
export type SourceEvent = { work_log_id: string; event_date: string; status: string; notes: string };

export function saveListingSourceStatement(db: D1Database, key: string, source: string, history?: SourceEvent[]) {
  const serialized = history === undefined ? null : JSON.stringify(history);
  return db.prepare(`INSERT INTO listing_source_notes (identity_key, source_notes, event_history)
    VALUES (?, ?, COALESCE(?, '[]')) ON CONFLICT(identity_key) DO UPDATE SET
      source_notes = excluded.source_notes,
      event_history = COALESCE(?, listing_source_notes.event_history),
      updated_at = CURRENT_TIMESTAMP`).bind(key, source, serialized, serialized);
}

// Retain the original work attribution before an edit changes its status,
// memo, date or address. A later deletion can still prune its old raw entries.
export function captureListingSourceStatements(keys: Iterable<string>, db: D1Database) {
  return [...new Set(keys)].map((key) => db.prepare(`
    INSERT INTO listing_source_notes (identity_key, source_notes, event_history)
    SELECT l.identity_key, l.source_notes, CASE WHEN l.source_notes = '' THEN '[]' ELSE (SELECT json_group_array(json_object(
      'work_log_id', e.work_log_id, 'event_date', e.event_date, 'status', e.status, 'notes', e.notes))
      FROM listing_events e WHERE e.listing_key = l.identity_key) END
    FROM listings l WHERE l.identity_key = ?
      AND (l.source_notes <> '' OR EXISTS (
        SELECT 1 FROM listing_source_notes original WHERE original.identity_key = l.identity_key))
    ON CONFLICT(identity_key) DO UPDATE SET source_notes = excluded.source_notes,
      event_history = (SELECT json_group_array(json(value)) FROM (
        SELECT value FROM json_each(listing_source_notes.event_history)
        UNION SELECT value FROM json_each(excluded.event_history))),
      updated_at = CURRENT_TIMESTAMP`).bind(key));
}

// The work, its events, and the current listing are one durable change. Return
// SQL instead of reading events here so callers can append these projections to
// the same D1 batch, after the event mutations. All reads below therefore see
// the newly saved events and a failure rolls the entire user action back.
export function listingRebuildStatements(keys: Iterable<string>, db: D1Database = getD1()) {
  const statements: D1PreparedStatement[] = [];
  for (const key of new Set([...keys].filter(Boolean))) {
    // Capture compatibility/import writes before removing the projection. This
    // is in the caller's mutation batch, so a later failure also rolls it back.
    statements.push(...captureListingSourceStatements([key], db));
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
        CASE WHEN COALESCE(previous.source_notes, original.source_notes, '') = '' THEN COALESCE(summary.event_notes, '')
          WHEN COALESCE(summary.event_notes, '') = '' THEN COALESCE(previous.source_notes, original.source_notes, '')
          ELSE COALESCE(previous.source_notes, original.source_notes) || char(10) || summary.event_notes END,
        COALESCE(previous.source_notes, original.source_notes, ''), latest.is_demo, CURRENT_TIMESTAMP
      FROM latest CROSS JOIN summary
      LEFT JOIN listings previous ON previous.identity_key = latest.listing_key
      LEFT JOIN listing_source_notes original ON original.identity_key = latest.listing_key
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
