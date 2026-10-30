import { getD1 } from "../../../db";
import { apiError, integerQueryParam, ready } from "../_shared";
import {
  LISTING_NAME_ORDER, LISTING_NAME_DESC_ORDER, LISTING_TYPE_ORDER, LISTING_TYPE_DESC_ORDER,
  LISTING_OLDEST_ORDER, LISTING_RECENT_ORDER, LISTING_UPDATED_ORDER,
} from "../_ordering";
import { propertySearch } from "../_search.js";

export async function GET(request: Request) {
  try {
    await ready();
    const params = new URL(request.url).searchParams;
    const q = params.get("q")?.trim() ?? "";
    const state = params.get("state") ?? "all";
    const type = params.get("type")?.trim() ?? "";
    const sort = params.get("sort") ?? "type";
    const limit = integerQueryParam(params.get("limit"), 1000, 1, 1000);
    const offset = integerQueryParam(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const statuses = [...new Set(params.getAll("status").map(value => value.trim()))];
    const prices = [...new Set(params.getAll("price"))];
    const priceColumns: Record<string, string> = { sale: "sale_price", jeonse: "jeonse_price", monthly: "monthly_rent" };
    if (prices.some(price => !Object.hasOwn(priceColumns, price)) || statuses.some(status => !status || status.length > 100) || statuses.length > 30) {
      return Response.json({ error: "매물 조회 조건을 확인해 주세요." }, { status: 400 });
    }
    const orderBy = sort === "recent" ? LISTING_RECENT_ORDER
      : sort === "updated" ? LISTING_UPDATED_ORDER
      : sort === "oldest" ? LISTING_OLDEST_ORDER
      : sort === "building" ? LISTING_NAME_ORDER
      : sort === "building-desc" ? LISTING_NAME_DESC_ORDER
      : sort === "type-desc" ? LISTING_TYPE_DESC_ORDER : LISTING_TYPE_ORDER;
    const where: string[] = [];
    const binds: unknown[] = [];
    if (statuses.length) { where.push(`status IN (${statuses.map(() => "?").join(", ")})`); binds.push(...statuses); }
    if (prices.length) where.push(`(${prices.map(price => `LENGTH(TRIM(COALESCE(${priceColumns[price]}, ''), char(9)||char(10)||char(13)||' ')) > 0`).join(" OR ")})`);
    if (type) {
      where.push("property_type = ?");
      binds.push(type);
    }
    if (state === "active") where.push("closed_at IS NULL");
    if (state === "closed") where.push("closed_at IS NOT NULL");
    if (state === "stale") where.push("closed_at IS NULL AND date(COALESCE(NULLIF(updated_at, ''), registered_at, '1900-01-01')) <= date('now','+9 hours','-90 days')");
    if (q) {
      const search = propertySearch(q);
      where.push(search.sql);
      binds.push(...search.bindings);
    }
    const predicate = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const db = getD1();
    const [count, rows] = await db.batch<Record<string, unknown>>([
      db.prepare(`SELECT COUNT(*) AS total FROM listings ${predicate}`).bind(...binds),
      db.prepare(`SELECT * FROM listings ${predicate} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).bind(...binds, limit, offset),
    ]);
    const total = Number(count.results[0]?.total ?? 0);
    return Response.json({ listings: rows.results, total, hasMore: offset + rows.results.length < total });
  } catch (error) {
    return apiError(error, "매물 목록을 불러오지 못했습니다.");
  }
}
