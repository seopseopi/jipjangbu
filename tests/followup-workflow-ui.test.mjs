import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// Run the production component's markup and event handlers with only synthetic
// records and controlled hooks/I/O. This does not write application databases.
const source = readFileSync(new URL("../app/follow-ups.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("follow-ups.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
    && node.initializer.expression.getText(ast) === "useState") names.push(node.name.elements[0].getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
const functions = ast.statements.filter(ts.isFunctionDeclaration).map((node) => node.getText(ast).replace(/^export /, "")).join("\n");
const compiled = ts.transpileModule(functions, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
}).outputText;
const synthetic = {
  id: "synthetic-task", revision: "a".repeat(64), title: "예시 고객에게 확인 전화", notes: "원래 메모", due_date: "2026-09-13",
  customer_id: "synthetic-customer", listing_key: "synthetic-listing", completed_at: null,
  created_at: "2026-09-12 01:00:00", updated_at: "2026-09-12 01:00:00",
  customer_name: "예시 고객", listing_label: "예시단지 106동 1503호",
};
const response = { items: [synthetic], summary: { open: 20, today: 3, overdue: 2, completed: 7 } };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function descendants(element) {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray(element.props.children).flatMap(descendants)];
}
function find(tree, predicate) {
  const element = descendants(tree).find(predicate);
  assert.ok(element, "production control exists");
  return element;
}
function button(tree, text) {
  return find(tree, (element) => element.type === "button" && renderToStaticMarkup(element).includes(text));
}
function harness(overrides = {}, props = {}, io = async () => response) {
  const state = { data: response, loadedKey: JSON.stringify(["all", ""]), loading: false, ...overrides };
  const refs = [], effects = [], calls = [], focus = [];
  let cursor = 0, refCursor = 0;
  const env = {
    React, Icon: () => null, DeletionDialog: () => null,
    useState(initial) {
      const key = names[cursor++];
      assert.ok(key);
      if (!(key in state)) state[key] = typeof initial === "function" ? initial() : initial;
      return [state[key], (next) => { state[key] = typeof next === "function" ? next(state[key]) : next; }];
    },
    useRef(initial) { const index = refCursor++; return refs[index] ??= { current: initial }; },
    useId: () => "test-followup", useEffect: (effect) => { effects.push(effect); }, useCallback: (fn) => fn,
    clientJsonFetch: async (...args) => { calls.push(args); return io(...args); },
    window: { confirm: () => true, requestAnimationFrame: (fn) => fn() },
    document: { getElementById: (id) => ({ focus: () => focus.push(id) }) },
  };
  const factory = new Function(...Object.keys(env), `${compiled}; return { FollowUpsView, followUpQueryKey, followUpReadState, todayDate };`);
  const production = factory(...Object.values(env));
  return {
    state, refs, effects, calls, focus, window: env.window, ...production,
    render(extra = {}) { cursor = 0; refCursor = 0; effects.length = 0; return production.FollowUpsView({ onOpenCustomer() {}, onOpenListing() {}, ...props, ...extra }); },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("홈과 전체 할 일은 날짜·제목·완료 체크 순서이며 오늘·내일·기한 지남·날짜 미정을 보존한다", () => {
  const today = harness().todayDate();
  const day = (offset) => new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  const cases = [
    { due_date: today, expected: /^오늘$/, highlighted: true },
    { due_date: day(1), expected: /^내일$/ },
    { due_date: day(-1), expected: /\d+월 \d+일$/, overdue: true },
    { due_date: "2025-12-30", expected: /^2025년 12월 30일$/, overdue: true },
    { due_date: null, expected: /^날짜 미정$/ },
    { due_date: day(-1), completed_at: `${today} 03:00:00`, expected: /^완료$/ },
  ];
  for (const compact of [true, false]) {
    for (const { expected, highlighted, overdue, ...values } of cases) {
      const item = { ...synthetic, ...values };
      const h = harness({ data: { ...response, items: [item] } }, { compact });
      const tree = h.render();
      const header = find(tree, (element) => element.props.className === "followup-item-top");
      const [date, title, complete] = React.Children.toArray(header.props.children);
      assert.ok(date.props.className.startsWith("followup-due"), "the date is the first header column, before the title and checkbox");
      const time = find(date, (element) => element.type === "time");
      assert.match(time.props.children, expected);
      assert.equal(descendants(date).some((element) => element.props.className === "followup-overdue-label" && element.props.children === "기한 지남"), !!overdue);
      assert.equal(time.props.dateTime, item.completed_at?.slice(0, 10) ?? item.due_date ?? undefined);
      assert.equal(date.props.className.includes("is-today"), !!highlighted);
      assert.equal(title.type, "h3");
      assert.equal(title.props.children, item.title);
      assert.equal(complete.props.className, "followup-check");
      assert.equal(complete.props["aria-pressed"], !!item.completed_at);
      assert.equal(complete.props.disabled, false);
      const body = find(tree, (element) => element.props.className === "followup-item-body");
      assert.equal(find(body, (element) => element.props.className === "followup-notes").props.children, item.notes);
      assert.ok(!descendants(header).some((element) => element.props.className === "followup-notes"), "notes retain the full row beneath the date/title header");
    }
  }
});

test("할 일 날짜는 쪼개지지 않고 좁은 영역의 제목·메모는 전체 폭, 완료 버튼은 44px 영역을 유지한다", () => {
  const css = readFileSync(new URL("../app/follow-ups.css", import.meta.url), "utf8");
  assert.match(css, /\.followup-item\s*\{\s*display:\s*block/);
  assert.match(css, /\.followup-item-top\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*max-content minmax\(0,\s*1fr\) auto/);
  assert.match(css, /\.followup-compact \.followup-item-top\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.followup-compact \.followup-item-top > h3\s*\{[^}]*order:\s*1;[^}]*flex-basis:\s*100%/);
  const mobile = css.slice(css.indexOf("@media (max-width: 700px)"));
  assert.match(mobile, /\.followup-item-top\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap/);
  assert.match(mobile, /\.followup-item-top > h3\s*\{[^}]*order:\s*1;[^}]*flex-basis:\s*100%/);
  assert.match(css, /\.followup-due time\s*\{[^}]*min-width:\s*0;[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.followup-check\s*\{[^}]*min-width:\s*72px;[^}]*min-height:\s*44px/);
  assert.match(css, /\.followup-due\s*\{[^}]*font-size:\s*var\(--text-base\)/);
  assert.match(css, /\.followup-due\s*\{[^}]*font-weight:\s*600/);
});

test("완료 글씨를 표시하며 확인 취소는 저장하지 않고 승인해야 완료 요청을 보낸다", async () => {
  for (const compact of [true, false]) {
    const h = harness({}, { compact });
    const messages = [];
    h.window.confirm = (message) => { messages.push(message); return false; };
    const complete = () => find(h.render(), (element) => element.props.className === "followup-check");
    assert.match(renderToStaticMarkup(complete()), />완료<\/button>/);
    complete().props.onClick();
    await flush();
    assert.equal(h.calls.length, 0);
    assert.match(messages[0], /완료 처리할까요/);
    assert.ok(messages[0].includes(synthetic.title));
    h.window.confirm = () => true;
    complete().props.onClick();
    await flush();
    const patches = h.calls.filter(([, options]) => options?.method === "PATCH");
    assert.equal(patches.length, 1);
    assert.deepEqual(JSON.parse(patches[0][1].body), { completed: true, revision: synthetic.revision });
  }
});

test("홈 할 일 요약은 오늘 다음 기한 지남 순서이며 숫자와 강조를 함께 유지한다", () => {
  for (const summary of [response.summary, { ...response.summary, today: 0, overdue: 0 }]) {
    const h = harness({ data: { ...response, summary } }, { compact: true });
    const urgency = find(h.render(), (element) => element.props.className === "followup-urgency");
    const cards = React.Children.toArray(urgency.props.children);
    assert.equal(cards.length, 2);
    assert.match(renderToStaticMarkup(cards[0]), new RegExp(`오늘</span><strong>${summary.today}<small>건`));
    assert.match(renderToStaticMarkup(cards[1]), new RegExp(`기한 지남</span><strong>${summary.overdue}<small>건`));
    assert.equal(cards[0].props.className.includes("is-today"), summary.today > 0);
    assert.equal(cards[1].props.className.includes("is-overdue"), summary.overdue > 0);
  }
});

test("홈에서 새 할 일 추가를 열어 메모를 함께 저장하고 갱신된 목록에서도 읽는다", async () => {
  const pending = deferred();
  let saved;
  const h = harness({}, { compact: true }, async (_url, options) => {
    if (options?.method === "POST") {
      const body = JSON.parse(options.body);
      saved = { ...synthetic, title: body.title, notes: body.notes, customer_id: null, listing_key: null };
      return pending.promise;
    }
    return { ...response, items: [saved] };
  });
  const notesField = () => find(h.render(), (element) => element.type === "textarea" && element.props.id.endsWith("new-notes"));
  assert.equal(descendants(h.render()).some((element) => element.type === "form"), false);
  button(h.render(), "새 할 일 추가").props.onClick();
  assert.equal(notesField().props.value, "");
  assert.equal(notesField().props.required, undefined, "notes remain optional");
  const label = find(h.render(), (element) => element.type === "label" && element.props.htmlFor === notesField().props.id);
  assert.match(renderToStaticMarkup(label), /메모.*선택/);
  find(h.render(), (element) => element.type === "input" && element.props.id.endsWith("new-title"))
    .props.onChange({ target: { value: "합성 방문 일정 확인" } });
  const notes = "확인할 사항 첫 줄\n두 번째 메모";
  notesField().props.onChange({ target: { value: notes } });
  const form = find(h.render(), (element) => element.type === "form");
  form.props.onSubmit({ preventDefault() {} });
  form.props.onSubmit({ preventDefault() {} });
  assert.equal(h.calls.length, 1, "duplicate submission stays blocked");
  assert.equal(notesField().props.disabled, true);
  const [url, options] = h.calls[0];
  assert.equal(url, "/api/follow-ups");
  assert.equal(options.method, "POST");
  assert.deepEqual(JSON.parse(options.body), {
    title: "합성 방문 일정 확인", notes, dueDate: h.todayDate(), customerId: null, listingKey: null,
  });
  pending.resolve({ item: saved });
  await flush();
  assert.equal(h.calls.length, 2, "saved data is reloaded");
  assert.equal(h.state.showForm, false, "a saved form closes back to the compact add button");
  const stored = find(h.render(), (element) => element.props.className === "followup-notes");
  assert.equal(stored.props.children, notes);
  assert.equal(h.state.draft.title, "");
  assert.match(h.state.notice, /할 일을 추가했습니다/);
  button(h.render(), "새 할 일 추가").props.onClick();
  assert.equal(notesField().props.value, "", "a fresh form exposes the optional notes again");
});

test("홈 메모 저장 실패 시 입력한 제목·메모를 보존해 재시도할 수 있다", async () => {
  const h = harness({}, { compact: true }, async () => { throw new Error("합성 저장 실패"); });
  button(h.render(), "새 할 일 추가").props.onClick();
  find(h.render(), (element) => element.type === "input" && element.props.id.endsWith("new-title"))
    .props.onChange({ target: { value: "보존할 합성 제목" } });
  find(h.render(), (element) => element.type === "textarea")
    .props.onChange({ target: { value: "보존할 합성 메모\n다음 줄" } });
  find(h.render(), (element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  await flush();
  assert.equal(h.state.draft.title, "보존할 합성 제목");
  const notes = find(h.render(), (element) => element.type === "textarea");
  assert.equal(notes.props.value, "보존할 합성 메모\n다음 줄");
  assert.equal(notes.props.disabled, false);
  assert.match(renderToStaticMarkup(h.render()), /입력한 내용은 유지됩니다/);
  assert.equal(h.calls.length, 1);
});

test("할 일 삭제는 공통 확인창을 먼저 열고 취소하면 목록·초안을 보존한다", () => {
  const h = harness({ draft: { title: "작성 중인 합성 초안" } });
  button(h.render(), "삭제").props.onClick();
  assert.equal(h.state.deletionId, synthetic.id);
  assert.equal(h.calls.length, 0);
  const dialog = find(h.render(), (element) => element.props.type === "followup" && element.props.id === synthetic.id);
  dialog.props.onClose();
  assert.equal(h.state.deletionId, null);
  assert.equal(h.state.draft.title, "작성 중인 합성 초안");
  assert.equal(h.state.data, response);
});

test("할 일 휴지통 이동 성공은 원래 필터 목록을 갱신하고 복구 위치를 안내한다", async () => {
  const changes = [], busy = [];
  const h = harness({ deletionId: synthetic.id, filter: "today", loadedKey: JSON.stringify(["today", ""]) }, { onChange: () => changes.push(true), onBusyChange: (value) => busy.push(value), onOpenTrash() {} });
  const dialog = find(h.render(), (element) => element.props.type === "followup" && element.props.id === synthetic.id);
  dialog.props.onBusyChange(true);
  assert.equal(h.state.busyId, synthetic.id);
  dialog.props.onBusyChange(false);
  dialog.props.onDeleted({ ok: true, trashId: "synthetic-trash" });
  await flush();
  assert.equal(h.state.deletionId, null);
  assert.equal(changes.length, 1);
  assert.deepEqual(busy, [true, false]);
  assert.match(h.calls[0][0], /due=today/);
  assert.ok(button(h.render(), "휴지통 보기"));
});

test("할 일 검색은 입력 즉시 조건을 구분하고 지연된 과거 오류를 무시한다", () => {
  const { followUpQueryKey: key, followUpReadState: status } = harness();
  assert.equal(key(true, "completed", "주소"), key(true, "all", ""));
  assert.equal(key(false, "all", " 주소 "), key(false, "all", "주소"));
  assert.equal(status("old", "new", false, null), "loading");
  assert.equal(status("new", "new", true, null), "refreshing");
  assert.equal(status("new", "new", false, { key: "old", message: "실패" }), "ready");
  assert.equal(status("old", "new", false, { key: "new", message: "실패" }), "error");
});

test("새 주소 검색과 필터 대기에는 이전 할 일과 결과 건수를 노출하지 않는다", () => {
  for (const overrides of [{ query: "106동 1503호" }, { filter: "completed" }]) {
    const h = harness(overrides);
    const html = renderToStaticMarkup(h.render());
    assert.doesNotMatch(html, /예시 고객에게 확인 전화|원래 메모|>1건</);
    assert.match(html, /aria-busy="true"/);
    assert.doesNotMatch(html, /할 일이 없습니다/);
  }
});

test("같은 조건의 갱신에는 읽던 목록을 보존하고 완료·수정·미루기·이력 조작을 잠근다", () => {
  const h = harness({ loading: true }), tree = h.render();
  assert.match(renderToStaticMarkup(tree), /예시 고객에게 확인 전화|같은 조건의 기존 목록/);
  for (const className of ["followup-check", "followup-item-actions", "followup-links"]) {
    const section = find(tree, (element) => element.props.className === className);
    const buttons = descendants(section).filter((element) => element.type === "button");
    assert.ok(buttons.length);
    assert.ok(buttons.every((element) => element.props.disabled === true));
  }
});

test("조회 실패는 성공한 0건과 구분하고 현재 검색·필터 그대로 재시도한다", async () => {
  const key = JSON.stringify(["overdue", "106동 1503호"]);
  const h = harness({ filter: "overdue", query: "106동 1503호", search: "이전 검색", loadError: { key, message: "합성 연결 실패" } });
  const tree = h.render(), html = renderToStaticMarkup(tree);
  assert.match(html, /할 일 목록을 확인하지 못했습니다|role="alert"/);
  assert.doesNotMatch(html, /예시 고객에게 확인 전화|할 일이 없습니다/);
  button(tree, "다시 불러오기").props.onClick();
  await flush();
  const url = new URL(h.calls[0][0], "https://synthetic.invalid");
  assert.equal(url.searchParams.get("q"), "106동 1503호");
  assert.equal(url.searchParams.get("due"), "overdue");
  assert.equal(h.state.loadedKey, key);
  assert.equal(h.state.loadError, null);
  const empty = harness({ data: { ...response, items: [] } });
  assert.match(renderToStaticMarkup(empty.render()), /지금 챙길 할 일이 없습니다/);
});

test("공유 읽기 캐시의 내부 취소는 무한 로딩이나 오래된 정상 목록 대신 재시도 오류가 된다", async () => {
  for (const loadedKey of [JSON.stringify(["all", ""]), JSON.stringify(["all", "106동 1503호"])]) {
    const key = JSON.stringify(["all", "106동 1503호"]);
    const h = harness({ query: "106동 1503호", search: "106동 1503호", loadedKey, loadError: { key, message: "이전 실패" } }, {}, async () => { throw new DOMException("공유 캐시 내부 취소", "AbortError"); });
    button(h.render(), "다시 불러오기").props.onClick();
    await flush();
    assert.equal(h.state.loading, false);
    assert.equal(h.state.loadError.key, key);
    assert.match(h.state.loadError.message, /조회를 완료하지 못했습니다/);
    const html = renderToStaticMarkup(h.render());
    assert.match(html, /role="alert"|다시 불러오기/);
    assert.doesNotMatch(html, /예시 고객에게 확인 전화|할 일이 없습니다|aria-busy="true"/);
  }
});

test("목록 갱신에서 수정 대상이 빠져도 입력 중인 초안과 연결 이력은 남는다", () => {
  const h = harness(), first = h.render();
  button(first, "수정</button>").props.onClick();
  const title = find(h.render(), (element) => element.type === "input" && element.props.id.endsWith("synthetic-task-title"));
  title.props.onChange({ target: { value: "저장 전 수정 제목" } });
  h.state.data = { ...response, items: [] };
  h.state.loadError = { key: h.state.loadedKey, message: "합성 갱신 실패" };
  const opened = [];
  const tree = h.render({ onOpenListing: (key) => opened.push(key) }), html = renderToStaticMarkup(tree);
  assert.match(html, /저장 전 수정 제목|원래 메모|예시단지 106동 1503호|할 일 수정 중/);
  button(tree, "매물 이력").props.onClick();
  assert.deepEqual(opened, [synthetic.listing_key]);
  assert.equal(h.state.editDraft.title, "저장 전 수정 제목");
  assert.deepEqual(h.focus, ["test-followup-synthetic-task-title"]);
});

test("고객·매물에서 이어진 새 할 일은 연결 대상 이름과 실제 이력 대상을 표시한다", () => {
  const draft = { title: "매물 다시 확인", notes: "", dueDate: "2026-09-13", customerId: synthetic.customer_id, listingKey: synthetic.listing_key };
  const opened = [];
  const h = harness({ showForm: true, draft, draftLabels: { customerName: synthetic.customer_name, listingLabel: synthetic.listing_label } }, {
    onOpenCustomer: (...args) => opened.push(args), onOpenListing: (key) => opened.push([key]),
  });
  const tree = h.render(), html = renderToStaticMarkup(tree);
  assert.match(html, /고객 · 예시 고객|매물 · 예시단지 106동 1503호/);
  assert.doesNotMatch(html, /선택한 고객|선택한 매물/);
  button(tree, "고객 이력").props.onClick();
  button(tree, "매물 이력").props.onClick();
  assert.deepEqual(opened, [[synthetic.customer_id, synthetic.customer_name], [synthetic.listing_key]]);
});

test("저장 실패는 초안을 보존하고 불러오기 버튼 대신 저장 재시도를 안내한다", async () => {
  const draft = { title: "보존할 제목", notes: "보존할 메모", dueDate: "2026-10-31", customerId: "", listingKey: "" };
  const busy = [];
  const h = harness({ showForm: true, draft }, { onBusyChange: (value) => busy.push(value) }, async () => { throw new Error("합성 저장 실패"); });
  const form = find(h.render(), (element) => element.type === "form");
  form.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(busy, [true], "the navigation guard is synchronous with the mutation lock");
  await flush();
  const tree = h.render(), html = renderToStaticMarkup(tree);
  assert.match(html, /변경을 저장하지 못했습니다|입력한 내용은 유지됩니다/);
  assert.doesNotMatch(html, /다시 불러오기/);
  assert.equal(h.state.draft.title, draft.title);
  assert.equal(h.state.draft.notes, draft.notes);
  assert.deepEqual(busy, [true, false]);
  assert.equal(h.calls.length, 1, "a failed write never starts a misleading read retry");
});

test("할 일 수정은 처음 읽은 revision을 보내고 충돌 뒤에도 작성 내용을 유지한다", async () => {
  const h = harness({}, {}, async (_url, options) => {
    if (options?.method === "PATCH") throw Object.assign(new Error("다른 기기에서 할 일이 변경되었습니다."), { status: 409 });
    return response;
  });
  button(h.render(), "수정</button>").props.onClick();
  const title = find(h.render(), (element) => element.type === "input" && element.props.id.endsWith("synthetic-task-title"));
  title.props.onChange({ target: { value: "보존할 수정 제목" } });
  const form = find(h.render(), (element) => element.type === "form" && element.props.className.includes("followup-form"));
  form.props.onSubmit({ preventDefault() {} });
  await flush();
  const patch = h.calls.find(([, options]) => options?.method === "PATCH");
  assert.equal(JSON.parse(patch[1].body).revision, synthetic.revision);
  assert.equal(h.state.editingId, synthetic.id);
  assert.equal(h.state.editDraft.title, "보존할 수정 제목");
  assert.match(h.state.mutationError, /다른 기기/);
});

test("충돌 뒤 최신 내용을 별도로 확인하며 취소할 때까지 초안과 기준 revision을 보존한다", async () => {
  const latest = { ...synthetic, title: "다른 기기 제목", notes: "다른 기기 메모", revision: "b".repeat(64) };
  const h = harness({}, {}, async (url, options) => {
    if (options?.method === "PATCH") throw Object.assign(new Error("동시 수정 충돌"), { status: 409 });
    if (url === `/api/follow-ups/${synthetic.id}`) return { item: latest };
    return { ...response, items: [latest] };
  });
  button(h.render(), "수정</button>").props.onClick();
  find(h.render(), (element) => element.type === "input" && element.props.id.endsWith("synthetic-task-title")).props.onChange({ target: { value: "내 초안" } });
  find(h.render(), (element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  await flush();
  button(h.render(), "최신 내용 확인").props.onClick();
  await flush();
  assert.equal(h.state.editDraft.title, "내 초안");
  assert.equal(h.state.editingRecord.revision, synthetic.revision);
  assert.match(renderToStaticMarkup(h.render()), /다른 기기 제목|다른 기기 메모/);
  h.window.confirm = () => false;
  button(h.render(), "최신 내용으로 다시 열기").props.onClick();
  assert.equal(h.state.editDraft.title, "내 초안");
  h.window.confirm = () => true;
  button(h.render(), "최신 내용으로 다시 열기").props.onClick();
  assert.equal(h.state.editDraft.title, latest.title);
  assert.equal(h.state.editingRecord.revision, latest.revision);
});

test("완료 처리 중 중복 입력을 막고 완료된 대상명과 다시 여는 위치를 안내한다", async () => {
  const pending = deferred();
  const h = harness({}, {}, (url, options) => options?.method ? pending.promise : Promise.resolve({ ...response, items: [] }));
  const tree = h.render(), complete = find(tree, (element) => element.props.className === "followup-check");
  complete.props.onClick();
  complete.props.onClick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.state.busyId, synthetic.id);
  const [url, options] = h.calls[0];
  assert.equal(url, `/api/follow-ups/${synthetic.id}`);
  assert.deepEqual(JSON.parse(options.body), { completed: true, revision: synthetic.revision });
  pending.resolve({ item: { ...synthetic, completed_at: "2026-09-13 03:00:00" } });
  await flush();
  assert.match(h.state.notice, /예시 고객에게 확인 전화.*완료 목록에서 다시 열 수 있습니다/);
  assert.equal(h.state.busyId, null);
});

test("오늘·내일 빠른 선택은 제목과 메모·연결을 건드리지 않는다", () => {
  const draft = { title: "예시 제목", notes: "예시 메모", dueDate: "2026-01-01", customerId: synthetic.customer_id, listingKey: synthetic.listing_key };
  const h = harness({ showForm: true, draft });
  const shortcuts = () => find(h.render(), (element) => element.props.className === "followup-date-shortcuts");
  button(shortcuts(), "오늘").props.onClick();
  assert.equal(h.state.draft.dueDate, h.todayDate());
  button(shortcuts(), "내일").props.onClick();
  assert.ok(h.state.draft.dueDate > h.todayDate());
  assert.equal(descendants(shortcuts()).filter((element) => element.type === "button").length, 2);
  assert.deepEqual(h.state.draft, { ...draft, dueDate: h.state.draft.dueDate });
});

test("홈은 다섯 건을 넘는 진행 할 일도 빠짐없이 표시한다", () => {
  const items = Array.from({ length: 9 }, (_, index) => ({ ...synthetic, id: `task-${index}`, title: `확인할 일 ${index}` }));
  const h = harness({ data: { ...response, items } }, { compact: true });
  const rows = descendants(h.render()).filter((element) => element.type === "article" && element.props.className.startsWith("followup-item"));
  assert.equal(rows.length, items.length);
  assert.deepEqual(rows.map((row) => find(row, (element) => element.type === "h3").props.children), items.map((item) => item.title));
});

test("할 일·예정일은 필수이고 메모는 선택이며 빈 날짜는 저장하지 않는다", () => {
  const draft = { title: "예정일 확인", notes: "메모 보존", dueDate: "", customerId: "", listingKey: "" };
  const h = harness({ showForm: true, draft }, { compact: true });
  const tree = h.render();
  assert.equal(find(tree, (element) => element.type === "input" && element.props.id.endsWith("new-title")).props.required, true);
  assert.equal(find(tree, (element) => element.type === "input" && element.props.type === "date").props.required, true);
  assert.equal(find(tree, (element) => element.type === "textarea").props.required, undefined);
  find(tree, (element) => element.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(h.calls.length, 0);
  assert.match(h.state.mutationError, /예정일/);
  assert.deepEqual(h.state.draft, draft);
});

test("필터의 전체 건수와 현재 검색 결과 건수를 명시적으로 구분한다", () => {
  const query = "106동 1503호";
  const h = harness({ query, search: query, loadedKey: JSON.stringify(["all", query]) });
  const html = renderToStaticMarkup(h.render());
  assert.match(html, /필터 숫자는 검색 전 전체 기준/);
  assert.match(html, /“106동 1503호”.*<strong>1건<\/strong>/);
  assert.match(html, /조건 초기화/);
});

test("부모에서 승인한 초안 교체는 두 번 묻지 않되 미승인 교체와 저장 중 교체를 막는다", () => {
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect"
      && node.arguments[1]?.getText(ast) === "[draftKey]") effect = node.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(effect);
  const script = ts.transpileModule(`const incomingDraftEffect = ${effect};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [approved, busy, expectedPrompts, expectedReplaced] of [[true, false, 0, true], [false, false, 1, false], [true, true, 0, false]]) {
    let prompts = 0, replaced = false, consumed = 0;
    const env = {
      draftKey: JSON.stringify({ title: "연결 매물 확인", replaceConfirmed: approved }),
      dirtyState: { current: { newDraft: true, editing: false, busy } },
      window: { setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {}, requestAnimationFrame: (fn) => fn(), confirm: () => { prompts++; return false; } },
      consumedCallback: { current: () => { consumed++; } }, emptyDraft: () => ({}),
      setDraftBaseline() {}, setDraft: () => { replaced = true; }, setDraftLabels() {}, setEditingId() {}, setEditingRecord() {}, setShowForm() {}, setNotice() {}, setMutationError() {}, titleInput: { current: null },
    };
    new Function(...Object.keys(env), `${script}; incomingDraftEffect();`)(...Object.values(env));
    assert.equal(prompts, expectedPrompts);
    assert.equal(replaced, expectedReplaced);
    assert.equal(consumed, 1);
  }
});
