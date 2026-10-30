import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const css = (file) => readFileSync(new URL(`../app/${file}.css`, import.meta.url), "utf8");

// Inspect the actual shared and lazy-loaded styles, including responsive overrides.
// These are CSS contract tests, not a substitute for a browser accessibility audit.
function rules(file, selector) {
  return [...css(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import[^;]+;/g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(",").some((value) => value.trim() === selector))
    .map(([, , declarations]) => Object.fromEntries(declarations.split(";").flatMap((part) => {
      const colon = part.indexOf(":");
      return colon < 0 ? [] : [[part.slice(0, colon).trim(), part.slice(colon + 1).trim()]];
    })));
}

function style(file, selector) {
  const matches = rules(file, selector);
  assert.ok(matches.length, `${file}: ${selector} must exist`);
  return Object.assign({}, ...matches);
}

const tokens = style("globals", ":root");

test("작은 휴대폰은 새 업무 라벨만 압축하고 검색의 44px 터치 폭과 전체 접근성 이름을 유지한다", () => {
  const search = style("globals", ".sidebar-actions .global-search-trigger");
  assert.equal(search.flex, "0 0 44px");
  assert.equal(search.width, "44px");
  assert.equal(search["min-height"], "44px");
  assert.match(css("globals"), /@media \(max-width: 380px\)\s*\{\s*\.sidebar-new-work-extra\s*\{\s*display: none;/);
  const compact = style("globals", ".sidebar-actions .sidebar-new-work");
  assert.equal(compact["font-size"], undefined, "large text must not be reduced to make controls fit");
  const source = readFileSync(new URL("../app/work-manager.tsx", import.meta.url), "utf8");
  assert.match(source, /className="primary-button sidebar-new-work"\s+aria-label="새 업무 등록"/);
  assert.match(source, /새 업무<span className="sidebar-new-work-extra"> 등록<\/span>/);
});

test("한글 본문 폰트는 외부 연결 없이 실제 WOFF2 파일·유니코드 서브셋·라이선스를 제공한다", () => {
  const fonts = css("fonts");
  assert.equal(tokens["--font-korean"], '"Pretendard Variable"');
  assert.match(css("globals"), /@import "\.\/fonts\.css"/);
  assert.doesNotMatch(readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8"), /next\/font/);
  assert.doesNotMatch(fonts.replace(/\/\*[\s\S]*?\*\//g, ""), /https?:\/\//);
  const faces = [...fonts.matchAll(/@font-face\s*\{([^}]+)\}/g)];
  const files = readdirSync(new URL("../public/fonts/pretendard/", import.meta.url)).filter((file) => file.endsWith(".woff2"));
  assert.ok(faces.length > 1, "only the subsets used by the visible text need downloading");
  const referenced = new Set();
  for (const [, face] of faces) {
    assert.match(face, /font-family: 'Pretendard Variable'/);
    assert.match(face, /font-weight: 45 920/);
    assert.match(face, /font-display: swap/);
    assert.match(face, /unicode-range: U\+/);
    const asset = face.match(/url\(\/fonts\/pretendard\/(PretendardVariable\.subset\.\d+\.woff2)\)/)?.[1];
    assert.ok(asset);
    referenced.add(asset);
    const data = readFileSync(new URL(`../public/fonts/pretendard/${asset}`, import.meta.url));
    assert.equal(data.subarray(0, 4).toString(), "wOF2");
  }
  assert.deepEqual([...referenced].sort(), files.sort());
  assert.match(readFileSync(new URL("../public/fonts/pretendard/OFL.txt", import.meta.url), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
});

test("좁은 달력은 일정 목록으로 전환하며 월간 칸의 날짜·고객·업무는 같은 압축 크기를 쓴다", () => {
  assert.equal(style("calendar", ".calendar-desktop-panel")["--text-base"], "15px");
  assert.equal(style("calendar", 'html[data-readable="true"] .calendar-desktop-panel')["--text-base"], "17px");
  assert.match(css("calendar"), /@media \(max-width: 1180px\)/);
  assert.equal(style("globals", ".listing-table .record-date")["white-space"], "nowrap");
  assert.equal(style("work-reading-list", ".work-record-meta").display, "flex");
  assert.equal(style("work-reading-list", ".work-record-meta")["flex-wrap"], "wrap");
});
function luminance(hex) {
  const rgb = hex.replace(/^#/, "");
  const full = rgb.length === 3 ? [...rgb].map((c) => c + c).join("") : rgb;
  const values = full.match(/../g).map((c) => {
    const value = parseInt(c, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return values.reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("본문·보조 글씨는 흰색과 회색 바탕 모두에서 충분히 진하다", () => {
  for (const foreground of ["--ink", "--ink-2", "--muted", "--faint"]) {
    for (const background of ["--paper", "--canvas", "--wash", "--tint"]) {
      const ratio = contrast(tokens[foreground], tokens[background]);
      assert.ok(ratio >= 4.5, `${foreground} / ${background}: ${ratio.toFixed(2)}`);
    }
  }
  assert.match(style("globals", "body").font, /^400 var\(--text-base\)\/1\.7/);
  assert.equal(style("globals", "h1")["font-weight"], "700");
  assert.equal(style("globals", "h2")["font-weight"], "700");
});

test("업무 종류와 주의 색상도 배경에서 읽히며 네이비 브랜드를 유지한다", () => {
  assert.equal(tokens["--green"], "#13254a");
  for (const color of ["green", "gold", "seal", "blue", "violet"]) {
    for (const background of ["--paper", `--${color}-soft`]) {
      assert.ok(contrast(tokens[`--${color}`], tokens[background]) >= 4.5, `${color} / ${background}`);
    }
  }
});

test("입력칸 경계와 카드 안팎의 구분이 옅어지지 않는다", () => {
  for (const background of ["--paper", "--canvas", "--wash"]) {
    assert.ok(contrast(tokens["--line-strong"], tokens[background]) >= 3, background);
  }
  assert.ok(contrast(tokens["--paper"], tokens["--canvas"]) >= 1.2);
  assert.ok(contrast(tokens["--line"], tokens["--paper"]) >= 1.8);
  assert.equal(style("globals", ".panel-head").background, "var(--wash)");
  assert.equal(style("work-reading-list", ".work-record-properties").border, "1px solid var(--line)");
  for (const [file, selector] of [
    ["globals", ".search-box"], ["follow-ups", ".followup-search input"],
    ["history-work-type-filter", ".history-work-type-filter select"],
    ["trash-view", ".trash-search"], ["trash-view", ".trash-type select"],
  ]) assert.equal(style(file, selector).border, "1px solid var(--line-strong)");
});

test("날짜·고객명·업무구분은 각 조회 화면에서 같은 기본 크기와 중간 600 굵기를 쓴다", () => {
  const surfaces = {
    globals: [".record-date", ".tag", ".table-row b", ".calendar-cell > b", ".history-record-meta",
      ".history-record-meta strong", ".history-record-meta > time", ".history-record-facts dd",
      ".history-entry-meta small", ".history-list strong", ".history-list .history-entry-meta > time",
      ".global-search-result-date", ".global-search-result-copy strong", ".global-search-result-meta",
      ".insights-item time", ".insights-item-date", ".insights-item-copy strong", ".insights-item-status", ".backup-row strong"],
    "work-reading-list": [".work-record-date", ".work-record-customer-link b"],
    "work-detail-view": [".work-read-meta time", ".work-read-type"],
    calendar: [".calendar-cell button .calendar-card-heading > span", ".calendar-agenda-day-head h2"],
    "calendar-subjects": [".calendar-subject-customer", ".calendar-cell button .calendar-subject-customer"],
    "listing-history-summary": [".history-record-saved-at"],
    "workflow-history-backup": [".history-list .history-entry-saved", ".history-entry-context > span:not(.work-summary-properties)"],
    "follow-ups": [".followup-due", ".followup-item h3", ".followup-compact .followup-item h3"],
    "trash-view": [".trash-record-action time", ".trash-deleted-time", ".trash-record-main strong"],
    "deletion-dialog": [".deletion-record-heading strong", ".deletion-record-heading p"],
    "work-form-feedback": [".work-copy-context > span"],
  };
  for (const [file, selectors] of Object.entries(surfaces)) for (const selector of selectors) {
    const value = style(file, selector);
    assert.equal(value["font-size"], "var(--text-base)", `${file}: ${selector} size`);
    assert.equal(value["font-weight"], "600", `${file}: ${selector} weight`);
  }
  assert.equal(style("work-detail-view", ".work-read-customer")["font-size"], "var(--text-base)");
  assert.equal(style("work-detail-view", ".work-read-customer strong")["font-weight"], "600");
});

test("일반·큰 글씨 모드에서 날짜도 함께 커지고 요약·모바일 메뉴가 작아지지 않는다", () => {
  const large = style("globals", 'html[data-readable="true"]');
  assert.equal(tokens["--text-base"], "16px");
  assert.equal(large["--text-base"], "18px");
  for (const name of ["--text-base", "--text-small", "--text-caption"]) {
    assert.ok(parseInt(large[name]) > parseInt(tokens[name]), name);
  }
  assert.equal(style("globals", '.app-shell[data-readable="true"] .nav-item')["font-size"], "var(--text-small)");
  for (const selector of [".metric-card p", ".metric-card button"]) {
    for (const value of rules("globals", selector)) assert.match(value["font-size"], /^var\(--text-/);
  }
});

test("매물·고객·백업 목록과 홈 날짜도 공통 날짜 스타일에 연결된다", () => {
  const source = readFileSync(new URL("../app/work-manager.tsx", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../app/settings-view.tsx", import.meta.url), "utf8");
  for (const field of ["item.registered_at", "item.closed_at", "item.last_work_date"]) {
    assert.ok(source.includes(`<time className="record-date" dateTime={${field}`), field);
  }
  assert.ok(settings.includes('<time className="record-date" dateTime={backup.createdAt}'));
  assert.ok(source.includes('<span className="record-date">{dateLabel}</span>'));
});

test("큰 업무 배지는 좁은 표와 모바일에서도 줄바꿈할 수 있다", () => {
  for (const [file, selector] of [["globals", ".table-row .tag"], ["calendar", ".calendar-agenda-event .tag"]]) {
    const value = style(file, selector);
    assert.equal(value["max-width"], "100%");
    assert.equal(value["white-space"], "normal");
    assert.equal(value["overflow-wrap"], "anywhere");
  }
});
