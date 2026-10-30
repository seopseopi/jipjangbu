import { getD1 } from "../../../db";
import { apiError, badRequest, integerQueryParam, ready } from "../_shared";
import { CUSTOMER_HISTORY_ORDER, CUSTOMER_LAST_WORK_DATE_SQL, CUSTOMER_NAME_ORDER, CUSTOMER_RECENT_ORDER } from "../_ordering";
import { textSearch } from "../_search.js";

export async function GET(request: Request) {
  try {
    await ready();
    const params = new URL(request.url).searchParams;
    const q = params.get("q")?.trim() ?? "";
    const sort = params.get("sort") ?? "recent";
    const directory = params.get("directory") === "1";
    const after = directory ? params.get("after") : null;
    // Keep the directory/older callers' 1,000-row contract. Management screens
    // request 100 explicitly; complete exports can still request 1,000.
    const limit = integerQueryParam(params.get("limit"), 1000, 1, 1000);
    const offset = integerQueryParam(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const orderBy = directory ? "c.id COLLATE BINARY" : sort === "name" ? CUSTOMER_NAME_ORDER : sort === "history" ? CUSTOMER_HISTORY_ORDER : CUSTOMER_RECENT_ORDER;
    const search = q ? textSearch(["c.id", "c.name", "c.notes"], q, ["c.id"]) : { sql: "1", bindings: [] };
    const cursorPredicate = after !== null ? "AND c.id > ? COLLATE BINARY" : "";
    const pageBindings = directory ? after !== null ? [after] : [] : [limit, offset];
    // The immutable-ID directory can stop at the page boundary before reading
    // histories. GROUP BY + a different ORDER BY previously aggregated every
    // remaining customer and their work before retaining only 1,000 rows.
    // Both subqueries use the existing customer/date covering index, and MAX
    // seeks the latest past date without walking every future reservation.
    const directoryLastWorkDate = `(SELECT MAX(w.work_date) FROM work_logs w
      WHERE w.customer_id = c.id AND w.work_date <= date('now','+9 hours'))`;
    const historyColumns = directory
      ? `(SELECT COUNT(*) FROM work_logs w WHERE w.customer_id = c.id) AS history_count,
        ${directoryLastWorkDate} AS last_work_date,
        COALESCE(${directoryLastWorkDate}, date(c.created_at,'+9 hours'), '1900-01-01') AS directory_sort_date`
      : `COUNT(w.id) AS history_count, ${CUSTOMER_LAST_WORK_DATE_SQL} AS last_work_date`;
    const db = getD1();
    const page = db.prepare(`
      SELECT c.id, c.name, c.notes, c.created_at, c.updated_at, c.is_demo,
        ${historyColumns}
      FROM customers c ${directory ? "" : "LEFT JOIN work_logs w ON w.customer_id = c.id"}
      WHERE (${search.sql}) ${cursorPredicate}
      ${directory ? "" : "GROUP BY c.id"} ORDER BY ${orderBy} LIMIT ${directory ? "1000" : "? OFFSET ?"}
    `).bind(...search.bindings, ...pageBindings);
    if (directory) {
      const rows = await page.all();
      return Response.json({ customers: rows.results });
    }
    // One snapshot keeps the number of matches and the displayed page aligned.
    // Customer search does not depend on work history, so count without joining
    // every historical work row a second time.
    const [count, rows] = await db.batch<Record<string, unknown>>([
      db.prepare(`SELECT COUNT(*) AS total FROM customers c WHERE (${search.sql})`).bind(...search.bindings),
      page,
    ]);
    const total = Number(count.results[0]?.total ?? 0);
    return Response.json({ customers: rows.results, total, hasMore: offset + rows.results.length < total });
  } catch (error) {
    return apiError(error, "고객 목록을 불러오지 못했습니다.");
  }
}

export async function POST(request: Request) {
  try {
    await ready();
    const body = await request.json() as { id?: string; name?: string; notes?: string };
    const id = body.id?.trim();
    const name = body.name?.trim();
    if (!id || !name) return badRequest("고객 ID와 고객명을 입력해 주세요.");
    const db = getD1();
    const exists = await db.prepare("SELECT id FROM customers WHERE id = ?").bind(id).first();
    if (exists) return Response.json({ error: "이미 등록된 고객 ID입니다." }, { status: 409 });
    await db.prepare("INSERT INTO customers (id, name, notes, is_demo) VALUES (?, ?, ?, 0)").bind(id, name, body.notes?.trim() ?? "").run();
    return Response.json({ customer: { id, name, notes: body.notes?.trim() ?? "" } }, { status: 201 });
  } catch (error) {
    return apiError(error, "고객을 등록하지 못했습니다.");
  }
}
