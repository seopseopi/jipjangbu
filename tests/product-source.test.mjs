import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("집장부 핵심 화면과 데이터 기능이 연결되어 있다", async () => {
  const [page, manager, settings, schema, hosting, workRoute, customerRoute, listingRoute, worker, security, login, layout] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/work-manager.tsx", root), "utf8"),
    readFile(new URL("app/settings-view.tsx", root), "utf8"),
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
    readFile(new URL("app/api/work-logs/route.ts", root), "utf8"),
    readFile(new URL("app/api/customers/route.ts", root), "utf8"),
    readFile(new URL("app/api/listings/route.ts", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("worker/security.ts", root), "utf8"),
    readFile(new URL("app/login/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);

  assert.match(page, /<WorkManager \/>/);
  for (const label of ["오늘의 업무", "업무일지", "매물 관리", "고객 관리", "업무 달력"]) {
    assert.match(manager, new RegExp(label));
  }
  for (const table of ["customers", "work_logs", "work_log_properties", "listings", "listing_events"]) {
    assert.match(schema, new RegExp(`sqliteTable\\(\\s*"${table}"`));
  }
  assert.equal(JSON.parse(hosting).d1, "DB");
  assert.equal(JSON.parse(hosting).r2, "BACKUPS");
  assert.doesNotMatch(manager, /react-loading-skeleton|_sites-preview/);
  assert.match(manager, /집장부 홈으로 이동/);
  assert.match(manager, /<strong>집장부<\/strong>/);
  for (const feature of ["바로 검색", "새 업무 등록", "renewal-pagination", "renewal-paginated-list", "sort-summary"]) {
    assert.match(manager, new RegExp(feature));
  }
  assert.doesNotMatch(manager, /업무 기간 필터|CSV 저장|CSV 준비 중|nav-test-badge/, "removed UI controls stay absent from the renewal");
  assert.match(manager, /<ResultPagination/);
  assert.match(manager, /이전 페이지/);
  assert.match(manager, /다음 페이지/);
  assert.match(manager, /history\.pushState/);
  assert.match(manager, /<Icon name="back"/);
  assert.match(workRoute, /COUNT\(\*\) AS total/);
  assert.match(customerRoute, /sort === "history"/);
  assert.match(listingRoute, /sort === "recent"/);
  assert.match(worker, /handleSecurityRequest/);
  assert.match(security, /HttpOnly.*SameSite=Strict/);
  assert.match(security, /MAX_LOGIN_ATTEMPTS = 5/);
  assert.match(security, /AES-GCM/);
  assert.match(security, /BACKUP_RETENTION_MS = 90/);
  assert.match(login, /마전현대공인중개사무소/);
  assert.match(login, /fetch\("\/api\/auth\/login"/);
  assert.match(login, /autoComplete="username"[^>]*required/);
  assert.match(login, /autoComplete="current-password"[^>]*required/);
  assert.match(settings, /지금 백업/);
  assert.match(settings, /로그아웃/);
  assert.match(layout, /jipjangbu-icon-bright\.png/);
});
