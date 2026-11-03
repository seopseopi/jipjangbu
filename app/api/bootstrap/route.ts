import { getD1 } from "../../../db";
import { apiError, ready } from "../_shared";
import {
  HOME_RECENT_WHERE,
  HOME_TODAY_ORDER,
  HOME_UPCOMING_ORDER,
  WORK_RECENT_ORDER,
} from "../_ordering";
import { WORK_SUMMARY_SQL } from "../_queries";

export async function GET() {
  try {
    await ready();
    const db = getD1();
    const [metricRows, today, recent, upcoming] = await db.batch<
      Record<string, unknown>
    >([
      db.prepare(`SELECT
        (SELECT COUNT(*) FROM work_logs WHERE work_date = date('now','+9 hours')) AS today_count,
        (SELECT COUNT(*) FROM work_logs WHERE work_date > date('now','+9 hours') AND work_date <= date('now','+9 hours','+7 days') AND (work_type LIKE '%예정' OR work_type LIKE '%예약')) AS upcoming_count,
        (SELECT COUNT(*) FROM listings WHERE closed_at IS NULL) AS active_listing_count,
        (SELECT COUNT(*) FROM customers) AS customer_count,
        EXISTS(SELECT 1 FROM work_logs WHERE is_demo = 0 LIMIT 1) AS has_real_work
      `),
      db.prepare(
        `${WORK_SUMMARY_SQL} WHERE w.work_date = date('now','+9 hours') ORDER BY ${HOME_TODAY_ORDER}`,
      ),
      db.prepare(
        `${WORK_SUMMARY_SQL} WHERE ${HOME_RECENT_WHERE} ORDER BY ${WORK_RECENT_ORDER} LIMIT 8`,
      ),
      db.prepare(
        `${WORK_SUMMARY_SQL} WHERE w.work_date > date('now','+9 hours') AND w.work_date <= date('now','+9 hours','+7 days') AND (w.work_type LIKE '%예정' OR w.work_type LIKE '%예약') ORDER BY ${HOME_UPCOMING_ORDER}`,
      ),
    ]);
    const { has_real_work, ...metrics } = metricRows.results[0];
    return Response.json({
      metrics,
      today: today.results,
      recent: recent.results,
      upcoming: upcoming.results,
      demoMode: Number(has_real_work) === 0,
    });
  } catch (error) {
    return apiError(error, "첫 화면 데이터를 불러오지 못했습니다.");
  }
}
