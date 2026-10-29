import { getD1 } from "../../../db";
import { apiError, integerQueryParam, ready } from "../_shared";
import { searchedWorkSummary, WORK_SUMMARY_SQL } from "../_queries";
import { propertySearch, workSearch } from "../_search.js";
import { HOME_TODAY_ORDER, HOME_UPCOMING_ORDER, WORK_RECENT_ORDER } from "../_ordering";
import { InputError, saveWorkLog, type WorkLogPayload } from "./data";

export async function GET(request: Request) {
  try {
    await ready();
    const params = new URL(request.url).searchParams;
    const q = params.get("q")?.trim() ?? "";
    const month = params.get("month")?.trim() ?? "";
    const workType = params.get("workType")?.trim() ?? "";
    const schedule = params.get("schedule") === "1";
    const customerId = params.get("customerId")?.trim() ?? "";
    const from = params.get("from")?.trim() ?? "";
    const to = params.get("to")?.trim() ?? "";
    const limit = integerQueryParam(params.get("limit"), 100, 1, 1000);
    const offset = integerQueryParam(
      params.get("offset"),
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    // Only include active predicates: optional-parameter ORs and substr(date)
    // prevented SQLite from seeking directly into the date/customer indexes.
    const where: string[] = [];
    const binds: (string | number)[] = [];
    if (schedule) where.push("(w.work_type LIKE '%예정' OR w.work_type LIKE '%예약')");
    if (workType) {
      where.push("w.work_type = ?");
      binds.push(workType);
    }
    if (customerId) {
      // Resolve the small set of related work IDs before reading summaries.
      // An OR with a per-work EXISTS made every customer's history scan the
      // entire journal, even for a ten-row page. UNION also removes records
      // connected both directly and through more than one property source.
      where.push(params.get("includeSource") === "1"
        ? "w.id IN (SELECT id FROM work_logs WHERE customer_id = ? UNION SELECT work_log_id FROM work_log_properties WHERE trim(source) = ?)"
        : "w.customer_id = ?");
      binds.push(customerId);
      if (params.get("includeSource") === "1") binds.push(customerId);
    }
    if (month) {
      if (month === "9999-12") {
        // SQLite date() cannot represent the following year (10000).
        where.push("w.work_date >= ? AND w.work_date <= ?");
        binds.push("9999-12-01", "9999-12-31");
      } else if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        where.push("w.work_date >= ? AND w.work_date < date(?, '+1 month')");
        binds.push(`${month}-01`, `${month}-01`);
      } else {
        where.push("0");
      }
    }
    if (from) {
      where.push("w.work_date >= ?");
      binds.push(from);
    }
    if (to) {
      where.push("w.work_date <= ?");
      binds.push(to);
    }
    if (q) {
      const search = workSearch(q);
      where.push(search.sql);
      binds.push(...search.bindings);
    }
    const db = getD1();
    const summary = q ? searchedWorkSummary(propertySearch(q, "sp", "work")) : { sql: WORK_SUMMARY_SQL, bindings: [] };
    const predicate = where.length ? `WHERE ${where.join(" AND ")}` : "";
    // One D1 round trip also gives the page and its total a consistent snapshot.
    const [count, rows] = await db.batch<Record<string, unknown>>([
      db
        .prepare(
          `SELECT COUNT(*) AS total FROM work_logs w JOIN customers c ON c.id = w.customer_id ${predicate}`,
        )
        .bind(...binds),
      db
        .prepare(
          `${summary.sql} ${predicate} ORDER BY ${params.get("sort") === "updated" ? HOME_TODAY_ORDER : schedule ? HOME_UPCOMING_ORDER : WORK_RECENT_ORDER} LIMIT ? OFFSET ?`,
        )
        .bind(...summary.bindings, ...binds, limit, offset),
    ]);
    return Response.json({
      workLogs: rows.results,
      total: Number(count.results[0]?.total ?? 0),
    });
  } catch (error) {
    return apiError(error, "업무일지를 불러오지 못했습니다.");
  }
}

export async function POST(request: Request) {
  try {
    await ready();
    const workLog = await saveWorkLog((await request.json()) as WorkLogPayload);
    return Response.json({ workLog }, { status: 201 });
  } catch (error) {
    if (error instanceof InputError)
      return Response.json({ error: error.message }, { status: error.status });
    return apiError(error, "업무를 저장하지 못했습니다.");
  }
}
