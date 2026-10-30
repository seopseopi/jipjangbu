import { getD1 } from "../../../../db";
import { apiError, ready } from "../../_shared";
import { WORK_SUMMARY_SQL } from "../../_queries";
import { WORK_RECENT_ORDER } from "../../_ordering";

export async function GET(_: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    await ready();
    const { key } = await params;
    const listingKey = key;
    const db = getD1();
    // Read the current value and its history in one snapshot, including when a
    // second signed-in device saves another event while this dialog is opening.
    const [listings, events, workLogs] = await db.batch([
      db.prepare("SELECT * FROM listings WHERE identity_key = ?").bind(listingKey),
      db.prepare(`
        SELECT e.*, c.id AS customer_id, c.name AS customer_name,
          w.created_at AS work_created_at, w.updated_at AS work_updated_at
        FROM listing_events e JOIN work_logs w ON w.id = e.work_log_id JOIN customers c ON c.id = w.customer_id
        WHERE e.listing_key = ?
        ORDER BY e.event_date DESC, e.event_order DESC, e.created_at DESC, e.id DESC
      `).bind(listingKey),
      db.prepare(`${WORK_SUMMARY_SQL}
        WHERE EXISTS (SELECT 1 FROM listing_events e WHERE e.work_log_id = w.id AND e.listing_key = ?)
          OR EXISTS (SELECT 1 FROM work_log_properties sp WHERE sp.work_log_id = w.id
            AND lower(trim(sp.property_type) || '|' || trim(sp.building_name) || '|' || trim(sp.building_dong) || '|' || trim(sp.unit_number)) = ?)
        ORDER BY ${WORK_RECENT_ORDER}
      `).bind(listingKey, listingKey),
    ]);
    // Ordinary work (visits, calls, etc.) can reference a property that has never
    // had a listing-status event. Do not discard those work records just because
    // the derived current-listing row does not exist; reading must not create one.
    const listing = listings.results[0] ?? null;
    if (!listing && !events.results.length && !workLogs.results.length) {
      return Response.json({ error: "매물을 찾을 수 없습니다." }, { status: 404 });
    }
    return Response.json({ listing, events: events.results, workLogs: workLogs.results });
  } catch (error) {
    return apiError(error, "매물 이력을 불러오지 못했습니다.");
  }
}
