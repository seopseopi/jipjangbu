"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { clientJsonFetch } from "./client-api";
import { Icon } from "./icons";
import { DeletionDialog } from "./deletion-dialog";
import "./follow-ups.css";

export type FollowUpItem = {
  id: string;
  title: string;
  notes: string;
  due_date: string | null;
  customer_id: string | null;
  listing_key: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  customer_name: string | null;
  listing_label: string | null;
  revision: string;
};

export type FollowUpsViewProps = {
  compact?: boolean;
  refreshKey?: number;
  onChange?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  onOpenCustomer?: (id: string, name: string) => void;
  onOpenListing?: (key: string) => void;
  initialDraft?: { title?: string; customerId?: string; listingKey?: string; customerName?: string; listingLabel?: string; replaceConfirmed?: boolean };
  onDraftConsumed?: () => void;
  // The parent owns the navigation confirmation, using onDirtyChange above.
  onShowAll?: () => void;
  onOpenTrash?: () => void;
};

type FollowUpsResponse = {
  items: FollowUpItem[];
  summary: { open: number; overdue: number; today: number; completed: number };
};
type Filter = "all" | "today" | "overdue" | "upcoming" | "completed";
type Draft = { title: string; notes: string; dueDate: string; customerId: string; listingKey: string };
type ReloadTarget = { filter: Filter; search: string };
type LoadError = { key: string; message: string } | null;

function followUpQueryKey(compact: boolean, filter: Filter, search: string) {
  return JSON.stringify(compact ? ["all", ""] : [filter, search.trim()]);
}

function followUpReadState(loadedKey: string | null, desiredKey: string, loading: boolean, error: LoadError) {
  if (error?.key === desiredKey) return "error";
  if (loadedKey !== desiredKey) return "loading";
  return loading ? "refreshing" : "ready";
}

function todayDate() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (key: string) => parts.find((item) => item.type === key)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function nextDay(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function emptyDraft(): Draft {
  return { title: "", notes: "", dueDate: todayDate(), customerId: "", listingKey: "" };
}

function differentDraft(a: Draft, b: Draft) {
  return a.title !== b.title || a.notes !== b.notes || a.dueDate !== b.dueDate || a.customerId !== b.customerId || a.listingKey !== b.listingKey;
}

function dueText(item: FollowUpItem, today: string) {
  if (item.completed_at) return "완료";
  if (!item.due_date) return "날짜 미정";
  if (item.due_date === today) return "오늘";
  if (item.due_date === nextDay(today)) return "내일";
  const [year, month, day] = item.due_date.split("-");
  const label = `${year === today.slice(0, 4) ? "" : `${year}년 `}${Number(month)}월 ${Number(day)}일`;
  return label;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "처리하지 못했습니다. 다시 시도해 주세요.";
}

export function FollowUpsView({ compact = false, refreshKey = 0, onChange, onDirtyChange, onBusyChange, onOpenCustomer, onOpenListing, initialDraft, onDraftConsumed, onShowAll, onOpenTrash }: FollowUpsViewProps) {
  const formId = useId();
  const [data, setData] = useState<FollowUpsResponse | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<LoadError>(null);
  const [mutationError, setMutationError] = useState("");
  const [mutationConflict, setMutationConflict] = useState(false);
  const [conflictRecord, setConflictRecord] = useState<{ id: string; latest?: FollowUpItem; loading?: boolean; error?: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [deletionId, setDeletionId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(compact);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [draftBaseline, setDraftBaseline] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRecord, setEditingRecord] = useState<FollowUpItem | null>(null);
  const [draftLabels, setDraftLabels] = useState({ customerName: "", listingLabel: "" });
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);
  const [editBaseline, setEditBaseline] = useState<Draft>(emptyDraft);
  const [busyId, setBusyId] = useState<string | null>(null);
  const mutationLock = useRef(false);
  const request = useRef<AbortController | null>(null);
  const consumedCallback = useRef(onDraftConsumed);
  const dirtyCallback = useRef(onDirtyChange);
  const busyCallback = useRef(onBusyChange);
  const titleInput = useRef<HTMLInputElement>(null);
  const dirtyState = useRef({ newDraft: false, editing: false, busy: false });
  const draftKey = initialDraft ? JSON.stringify(initialDraft) : "";
  const today = todayDate();
  const draftDirty = showForm && differentDraft(draft, draftBaseline);
  const editDirty = !!editingId && differentDraft(editDraft, editBaseline);
  const hasUnsavedChanges = draftDirty || editDirty;
  const desiredKey = followUpQueryKey(compact, filter, query);
  const readState = followUpReadState(loadedKey, desiredKey, loading, loadError);
  const listReady = readState === "ready";

  useEffect(() => { dirtyCallback.current = onDirtyChange; }, [onDirtyChange]);
  useEffect(() => { dirtyCallback.current?.(hasUnsavedChanges); }, [hasUnsavedChanges]);
  useEffect(() => () => { dirtyCallback.current?.(false); }, []);
  useEffect(() => { busyCallback.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => { busyCallback.current?.(!!busyId); }, [busyId]);
  useEffect(() => () => { busyCallback.current?.(false); }, []);

  useEffect(() => { dirtyState.current = { newDraft: draftDirty, editing: editDirty, busy: !!busyId }; }, [draftDirty, editDirty, busyId]);

  useEffect(() => {
    if (!draftDirty && !editDirty && !busyId) return;
    const protectUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protectUnload);
    return () => window.removeEventListener("beforeunload", protectUnload);
  }, [draftDirty, editDirty, busyId]);

  useEffect(() => { consumedCallback.current = onDraftConsumed; }, [onDraftConsumed]);

  useEffect(() => {
    if (!draftKey) return;
    const timer = window.setTimeout(() => {
      const incoming = JSON.parse(draftKey) as NonNullable<FollowUpsViewProps["initialDraft"]>;
      if (dirtyState.current.busy || ((dirtyState.current.newDraft || dirtyState.current.editing) && incoming.replaceConfirmed !== true && !window.confirm("저장하지 않은 내용이 있습니다. 작성을 취소하고 새 할 일을 열까요?"))) {
        consumedCallback.current?.();
        return;
      }
      const base = emptyDraft();
      setDraftBaseline(base);
      setDraft({ ...base, ...incoming });
      setDraftLabels({ customerName: incoming.customerName ?? "", listingLabel: incoming.listingLabel ?? "" });
      setEditingId(null);
      setEditingRecord(null);
      setShowForm(true);
      setNotice("");
      setMutationError("");
      consumedCallback.current?.();
      window.requestAnimationFrame(() => titleInput.current?.focus());
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draftKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const reload = useCallback(async (target?: ReloadTarget) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setLoadError(null);
    const nextFilter = target?.filter ?? filter;
    const nextSearch = target?.search ?? search;
    const key = followUpQueryKey(compact, nextFilter, nextSearch);
    const params = new URLSearchParams({
      status: !compact && nextFilter === "completed" ? "completed" : "open",
      due: compact || nextFilter === "completed" ? "all" : nextFilter,
    });
    if (!compact && nextSearch) params.set("q", nextSearch);
    try {
      const response = await clientJsonFetch<FollowUpsResponse>(`/api/follow-ups?${params}`, { signal: controller.signal });
      if (!controller.signal.aborted) {
        setData(response);
        setLoadedKey(key);
      }
    } catch (loadError) {
      if (!controller.signal.aborted) setLoadError({ key, message: loadError instanceof Error && loadError.name === "AbortError" ? "조회를 완료하지 못했습니다. 다시 불러와 주세요." : errorText(loadError) });
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [compact, filter, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void reload(); }, 0);
    // The workspace coalesces focus/visibility refreshes for all active views.
    return () => {
      window.clearTimeout(timer);
      request.current?.abort();
    };
  }, [reload, refreshKey]);

  async function mutate(id: string, method: "POST" | "PATCH", body: unknown, message: string, afterSave?: () => void) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    busyCallback.current?.(true);
    setBusyId(id);
    setMutationError("");
    setNotice("");
    setMutationConflict(false);
    setConflictRecord(null);
    try {
      await clientJsonFetch(method === "POST" ? "/api/follow-ups" : `/api/follow-ups/${encodeURIComponent(id)}`, {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      afterSave?.();
      setNotice(message);
      if (method === "POST") {
        setFilter("all");
        setQuery("");
        setSearch("");
        await reload({ filter: "all", search: "" });
      } else await reload();
      onChange?.();
    } catch (saveError) {
      setMutationError(errorText(saveError));
      if ((saveError as { status?: number })?.status === 409) {
        setMutationConflict(true);
        if (editingId === id) setConflictRecord({ id });
        // Refresh quick-action revisions, while preserving the original edit
        // record and draft until the user explicitly reviews the newer values.
        await reload();
      }
    } finally {
      mutationLock.current = false;
      setBusyId(null);
      busyCallback.current?.(false);
    }
  }

  function saveDraft(event: React.FormEvent<HTMLFormElement>, value: Draft, id?: string) {
    event.preventDefault();
    if (!id && editingId) return;
    const title = value.title.trim();
    if (!title) return;
    void mutate(id ?? "new", id ? "PATCH" : "POST", {
      title,
      notes: value.notes.trim(),
      dueDate: value.dueDate || null,
      customerId: value.customerId || null,
      listingKey: value.listingKey || null,
      ...(id ? { revision: editingRecord?.revision } : {}),
    }, `“${title}” ${id ? "수정을 저장했습니다." : "할 일을 추가했습니다."}`, () => {
      if (id) { setEditingId(null); setEditingRecord(null); }
      else {
        const next = emptyDraft();
        setDraft(next);
        setDraftBaseline(next);
        setDraftLabels({ customerName: "", listingLabel: "" });
        setShowForm(compact);
      }
    });
  }

  function startEdit(item: FollowUpItem, confirmedLatest = false) {
    if (busyId || (!confirmedLatest && !listReady)) return;
    if (editDirty && !window.confirm("저장하지 않은 수정 내용이 있습니다. 취소하고 다른 할 일을 수정할까요?")) return;
    const next = { title: item.title, notes: item.notes ?? "", dueDate: item.due_date ?? "", customerId: item.customer_id ?? "", listingKey: item.listing_key ?? "" };
    setEditingId(item.id);
    setEditingRecord(item);
    setEditDraft(next);
    setEditBaseline(next);
    setNotice("");
    setMutationError("");
    setMutationConflict(false);
    setConflictRecord(null);
    window.requestAnimationFrame(() => document.getElementById(`${formId}-${item.id}-title`)?.focus());
  }

  async function reviewConflict() {
    if (!conflictRecord || conflictRecord.loading || busyId) return;
    const id = conflictRecord.id;
    setConflictRecord({ id, loading: true });
    try {
      const { item } = await clientJsonFetch<{ item: FollowUpItem }>(`/api/follow-ups/${encodeURIComponent(id)}`, { cache: "no-store" });
      setConflictRecord((current) => current?.id === id ? { id, latest: item } : current);
    } catch (error) {
      setConflictRecord((current) => current?.id === id ? { id, error: errorText(error) } : current);
    }
  }

  function cancelForm(editing?: string) {
    if ((editing ? editDirty : draftDirty) && !window.confirm("저장하지 않은 내용이 있습니다. 작성을 취소할까요?")) return;
    if (busyId) return;
    if (editing) { setEditingId(null); setEditingRecord(null); }
    else {
      const next = emptyDraft();
      setDraft(next);
      setDraftBaseline(next);
      setDraftLabels({ customerName: "", listingLabel: "" });
      setShowForm(compact);
    }
    setMutationError("");
    setMutationConflict(false);
    setConflictRecord(null);
  }

  function openNewForm() {
    if (busyId) return;
    if (editDirty && !window.confirm("저장하지 않은 수정 내용이 있습니다. 취소하고 새 할 일을 열까요?")) return;
    setEditingId(null);
    setEditingRecord(null);
    if (!draftDirty) {
      const next = emptyDraft();
      setDraft(next);
      setDraftBaseline(next);
      setDraftLabels({ customerName: "", listingLabel: "" });
    }
    setShowForm(true);
    setMutationError("");
    window.requestAnimationFrame(() => titleInput.current?.focus());
  }

  function showAll() {
    if (busyId) return;
    onShowAll?.();
  }

  function renderForm(value: Draft, update: (next: Draft) => void, editing?: string) {
    const id = `${formId}-${editing ?? "new"}`;
    const saved = editing ? editingRecord : null;
    const customerName = editing ? saved?.customer_name || "연결된 기록 확인 불가" : draftLabels.customerName || value.customerId;
    const listingLabel = editing ? saved?.listing_label || "연결된 기록 확인 불가" : draftLabels.listingLabel || "연결된 매물";
    return <form className={`followup-form${compact && !editing ? " followup-form-compact" : ""}`} onSubmit={(event) => saveDraft(event, value, editing)} onFocus={() => {
      if (busyId || editing || differentDraft(value, draftBaseline) || value.dueDate === todayDate()) return;
      const next = emptyDraft();
      setDraft(next);
      setDraftBaseline(next);
    }}>
      <div className="followup-form-main">
        <label className="followup-field followup-title-field" htmlFor={`${id}-title`}>
          <span>{editing ? "할 일 수정" : "무엇을 해야 하나요?"}</span>
          <input ref={editing ? undefined : titleInput} id={`${id}-title`} value={value.title} onChange={(event) => update({ ...value, title: event.target.value })} placeholder="예: 고객에게 상담 일정 확인하기" maxLength={200} required disabled={!!busyId} autoComplete="off" />
        </label>
        <div className="followup-field followup-date-field">
          <label htmlFor={`${id}-date`}>예정일 <small>선택</small></label>
          <input id={`${id}-date`} type="date" min="0001-01-01" max="9999-12-31" value={value.dueDate} onChange={(event) => update({ ...value, dueDate: event.target.value })} disabled={!!busyId} />
          <div className="followup-date-shortcuts" aria-label="예정일 빠른 선택">
            {[{ label: "오늘", value: today }, { label: "내일", value: nextDay(today) }, { label: "날짜 미정", value: "" }].map((option) => <button key={option.label} type="button" disabled={!!busyId} aria-pressed={value.dueDate === option.value} onClick={() => update({ ...value, dueDate: option.value })}>{option.label}</button>)}
          </div>
        </div>
      </div>
      <label className="followup-field" htmlFor={`${id}-notes`}>
        <span>메모 <small>선택</small></span>
        <textarea id={`${id}-notes`} rows={2} value={value.notes} onChange={(event) => update({ ...value, notes: event.target.value })} maxLength={5000} placeholder="다음 연락 때 확인할 내용을 남겨두세요." disabled={!!busyId} />
      </label>
      {(value.customerId || value.listingKey) && <div className="followup-linked-records" aria-label="연결된 기록">
        {value.customerId && <div className="followup-linked-record"><span>고객 · {customerName}</span><div className="followup-linked-actions">{onOpenCustomer && (!saved || saved.customer_name) && <button className="followup-linked-history" type="button" disabled={!!busyId} onClick={() => onOpenCustomer(value.customerId, customerName)}><Icon name="clock" size={16} />고객 이력</button>}<button type="button" disabled={!!busyId} onClick={() => update({ ...value, customerId: "" })}><Icon name="unlink" size={16} />연결 해제</button></div></div>}
        {value.listingKey && <div className="followup-linked-record"><span>매물 · {listingLabel}</span><div className="followup-linked-actions">{onOpenListing && (!saved || saved.listing_label) && <button className="followup-linked-history" type="button" disabled={!!busyId} onClick={() => onOpenListing(value.listingKey)}><Icon name="clock" size={16} />매물 이력</button>}<button type="button" disabled={!!busyId} onClick={() => update({ ...value, listingKey: "" })}><Icon name="unlink" size={16} />연결 해제</button></div></div>}
        {saved && ((value.customerId && !saved.customer_name) || (value.listingKey && !saved.listing_label)) && <p className="followup-link-warning">연결된 기록을 확인할 수 없습니다. 필요하면 연결을 해제해 주세요.</p>}
      </div>}
      {!editing && editingId && <p className="followup-link-note">수정 중인 할 일을 저장하거나 취소한 뒤 새 할 일을 추가할 수 있습니다.</p>}
      <div className="followup-form-actions">
        {!compact || editing || draftDirty ? <button className="followup-button" type="button" disabled={!!busyId} onClick={() => cancelForm(editing)}>취소</button> : null}
        <button className="followup-button followup-button-primary" type="submit" disabled={!!busyId || !value.title.trim() || (!editing && !!editingId)}><Icon name={editing ? "save" : "plus"} size={18} />{busyId === (editing ?? "new") ? "저장 중…" : editing ? "수정 저장" : "할 일 추가"}</button>
      </div>
    </form>;
  }

  const summary = readState === "error" ? undefined : data?.summary;
  const items = readState === "ready" || readState === "refreshing" ? data?.items ?? [] : [];
  const visibleItems = compact ? items.slice(0, 5) : items;
  const filters: Array<{ id: Filter; label: string; count?: number }> = [
    { id: "all", label: "전체 진행", count: summary?.open },
    { id: "today", label: "오늘", count: summary?.today },
    { id: "overdue", label: "기한 지남", count: summary?.overdue },
    { id: "upcoming", label: "앞으로 7일" },
    { id: "completed", label: "완료", count: summary?.completed },
  ];

  return <section className={`followup-view${compact ? " followup-compact" : ""}`} aria-label={compact ? "챙겨야 할 일" : "할 일 관리"}>
    <div className="followup-heading">
      <div><h2>{compact ? "챙겨야 할 일" : "할 일 목록"}</h2></div>
      {compact ? onShowAll && <button className="followup-button followup-button-link" disabled={!!busyId} onClick={showAll}>전체 보기</button> : !showForm && <button className="followup-button followup-button-primary" disabled={!!busyId} onClick={openNewForm}><Icon name="plus" size={18} />할 일 추가</button>}
    </div>

    {compact && summary && <div className="followup-urgency" aria-label="챙겨야 할 일 요약">
      <div className={`followup-urgency-count${summary.today ? " is-today" : ""}`}><Icon name="calendar" size={18} /><span>오늘</span><strong>{summary.today.toLocaleString()}<small>건</small></strong></div>
      <div className={`followup-urgency-count${summary.overdue ? " is-overdue" : ""}`}><Icon name="warning" size={18} /><span>기한 지남</span><strong>{summary.overdue.toLocaleString()}<small>건</small></strong></div>
    </div>}

    {!compact && <>
      <div className="followup-filters" aria-label="할 일 필터">
        {filters.map((item) => <button key={item.id} className={`followup-filter${filter === item.id ? " is-active" : ""}${item.id === "overdue" ? " is-overdue" : ""}`} aria-pressed={filter === item.id} onClick={() => { if (item.id === filter) return; if (editDirty && !window.confirm("저장하지 않은 수정 내용이 있습니다. 취소하고 목록을 바꿀까요?")) return; setFilter(item.id); setEditingId(null); setEditingRecord(null); setMutationError(""); }} disabled={!!busyId}>{item.label}{item.count !== undefined && <span>{item.count.toLocaleString()}</span>}</button>)}
      </div>
      <label className="followup-search" htmlFor={`${formId}-search`}><span>할 일 검색</span><input id={`${formId}-search`} type="search" maxLength={200} value={query} disabled={!!busyId || !!editingId} title={editingId ? "수정을 저장하거나 취소한 뒤 검색할 수 있습니다." : undefined} onChange={(event) => setQuery(event.target.value)} placeholder="할 일, 고객·연락처, 매물 주소, 메모 검색" /></label>
      <div className="followup-results-summary"><p><strong>{filters.find((item) => item.id === filter)?.label}</strong>{query.trim() && <> · “{query.trim()}”</>}{readState === "ready" && <> · <strong>{items.length.toLocaleString()}건</strong></>}</p><span>필터 숫자는 검색 전 전체 기준</span>{(query.trim() || filter !== "all") && <button type="button" className="followup-button" disabled={!!busyId || !!editingId} onClick={() => { setFilter("all"); setQuery(""); setSearch(""); }}>조건 초기화</button>}</div>
    </>}

    {!compact && showForm && renderForm(draft, setDraft)}
    {editingId && <div className="followup-edit-panel"><p className="followup-edit-heading"><Icon name="edit" size={18} /><strong>할 일 수정 중</strong><span>저장하거나 취소해 주세요.</span></p>{renderForm(editDraft, setEditDraft, editingId)}</div>}
    {mutationError && <div className="followup-message followup-error" role="alert"><span><Icon name="warning" size={18} /><span>변경을 저장하지 못했습니다. {mutationError}<br />{mutationConflict ? "입력한 내용은 유지됩니다. 최신 내용을 확인하거나 갱신된 목록에서 다시 선택해 주세요." : "입력한 내용은 유지됩니다. 해당 버튼으로 다시 시도해 주세요."}</span></span>{conflictRecord && <button type="button" className="followup-button" disabled={!!busyId || conflictRecord.loading} onClick={() => void reviewConflict()}>{conflictRecord.loading ? "확인 중…" : "최신 내용 확인"}</button>}</div>}
    {conflictRecord?.error && <p className="form-error" role="alert">{conflictRecord.error} 입력 중인 내용은 유지됩니다.</p>}
    {conflictRecord?.latest && <section className="followup-conflict" aria-label="충돌한 할 일의 최신 내용">
      <h3>최신 저장 내용</h3><strong>{conflictRecord.latest.title}</strong>
      <p>{conflictRecord.latest.notes || "메모 없음"}</p>
      <p>기한: {conflictRecord.latest.due_date || "날짜 미정"} · {conflictRecord.latest.completed_at ? "완료" : "진행 중"}</p>
      <button type="button" className="followup-button" disabled={!!busyId} onClick={() => startEdit(conflictRecord.latest!, true)}>최신 내용으로 다시 열기</button>
      <p className="form-help">다시 열면 현재 초안을 취소할지 먼저 확인합니다. 필요한 내용은 그 전에 복사해 주세요.</p>
    </section>}
    {readState === "error" && <div className="followup-message followup-error" role="alert"><span><Icon name="warning" size={18} /><span>할 일 목록을 확인하지 못했습니다.<br />{loadError?.message}</span></span><button className="followup-button" disabled={loading || !!busyId} onClick={() => { void reload({ filter, search: query.trim() }); }}><Icon name="refresh" size={18} />다시 불러오기</button></div>}
    {notice && <div className="followup-message followup-notice" role="status"><span><Icon name="check" size={18} />{notice}</span>{notice.includes("휴지통") && onOpenTrash && <button type="button" className="followup-button" onClick={onOpenTrash}>휴지통 보기</button>}<button className="followup-dismiss" aria-label="안내 닫기" onClick={() => setNotice("")}><Icon name="close" size={20} /></button></div>}

    {data && items.length > 0 && <p className="followup-sort-note">{!compact && filter === "completed" ? "최근 완료한 순" : compact ? "기한 지난 일 먼저 · 예정일순" : "기한 지난 일 → 예정일순 → 날짜 미정"}</p>}
    {readState === "loading" ? <div className="followup-empty" role="status" aria-busy="true"><span className="followup-loading-dot" aria-hidden="true" /><p>{query.trim() && !compact ? "입력한 조건으로 할 일을 찾고 있습니다." : "할 일을 불러오고 있습니다."}</p></div> : readState === "error" ? null : <div className="followup-list" aria-busy={readState === "refreshing"}>
      {readState === "refreshing" && <p className="followup-refresh" role="status">최신 상태를 확인 중입니다. 같은 조건의 기존 목록을 표시하고 있습니다.</p>}
      {!visibleItems.length && listReady ? <div className="followup-empty"><span className="followup-empty-symbol" aria-hidden="true"><Icon name={search && !compact ? "search" : "tasks"} size={24} /></span><strong>{search && !compact ? "검색된 할 일이 없습니다" : filter === "completed" && !compact ? "완료한 할 일이 없습니다" : filter !== "all" && !compact ? "해당하는 할 일이 없습니다" : "지금 챙길 할 일이 없습니다"}</strong><p>{search && !compact ? "다른 검색어나 필터로 찾아보세요." : "다음에 연락하거나 확인할 일을 남겨두세요."}</p></div> : null}
      {visibleItems.map((item) => <article key={item.id} className={`followup-item${item.completed_at ? " is-completed" : ""}${!item.completed_at && item.due_date && item.due_date < today ? " is-overdue" : ""}`}>
        {editingId === item.id ? <p className="followup-editing-marker"><Icon name="edit" size={18} />위에서 수정 중 · {item.title}</p> : <>
          <div className="followup-item-top">
            <span className={`followup-due${!item.completed_at && item.due_date === today ? " is-today" : ""}`}><Icon name={item.completed_at ? "check" : item.due_date && item.due_date < today ? "warning" : "calendar"} size={16} /><time dateTime={item.completed_at?.slice(0, 10) ?? item.due_date ?? undefined}>{dueText(item, today)}</time>{!item.completed_at && item.due_date && item.due_date < today && <small className="followup-overdue-label">기한 지남</small>}</span>
            <h3>{item.title}</h3>
          <button className="followup-check" title={item.completed_at ? "다시 진행하기" : "완료하기"} aria-label={`${item.title}: ${item.completed_at ? "다시 진행하기" : "완료하기"}`} aria-pressed={!!item.completed_at} disabled={!!busyId || !listReady || !!editingId} onClick={() => { if (!window.confirm(`“${item.title}” 할 일을 ${item.completed_at ? "다시 진행할까요?" : "완료 처리할까요?"}`)) return; void mutate(item.id, "PATCH", { completed: !item.completed_at, revision: item.revision }, `“${item.title}” ${item.completed_at ? "할 일을 다시 열었습니다. 전체 진행에서 확인할 수 있습니다." : "할 일을 완료했습니다. 완료 목록에서 다시 열 수 있습니다."}`); }}><span aria-hidden="true">{busyId === item.id ? <Icon name="clock" size={16} /> : item.completed_at ? <Icon name="check" size={18} /> : null}</span>{item.completed_at ? "다시 진행" : "완료"}</button>
          </div>
          <div className="followup-item-body">
            {item.notes && <p className="followup-notes">{item.notes}</p>}
            {(item.customer_id || item.listing_key) && <div className="followup-links">
              {item.customer_id && (onOpenCustomer && item.customer_name ? <button disabled={!!busyId || !listReady} onClick={() => onOpenCustomer(item.customer_id!, item.customer_name!)}><Icon name="customers" size={16} />고객 · {item.customer_name} <Icon name="upRight" size={16} /></button> : <span><Icon name="customers" size={16} />고객 · {item.customer_name ?? "연결된 기록 확인 불가"}</span>)}
              {item.listing_key && (onOpenListing && item.listing_label ? <button disabled={!!busyId || !listReady} onClick={() => onOpenListing(item.listing_key!)}><Icon name="listings" size={16} />매물 · {item.listing_label} <Icon name="upRight" size={16} /></button> : <span><Icon name="listings" size={16} />매물 · {item.listing_label ?? "연결된 기록 확인 불가"}</span>)}
            </div>}
            <div className="followup-item-actions">
              <button disabled={!!busyId || !listReady} onClick={() => startEdit(item)}><Icon name="edit" size={16} />수정</button>
              {!item.completed_at && <button disabled={!!busyId || !listReady || !!editingId || item.due_date === "9999-12-31"} onClick={() => { const base = item.due_date && item.due_date > today ? item.due_date : today; void mutate(item.id, "PATCH", { dueDate: nextDay(base), revision: item.revision }, `“${item.title}” 예정일을 ${nextDay(base)}로 미뤘습니다.`); }}><Icon name="calendarPlus" size={16} />{!item.due_date || item.due_date <= today ? "내일로 미루기" : "하루 미루기"}</button>}
              <button className="followup-delete" disabled={!!busyId || !listReady || !!editingId} onClick={() => setDeletionId(item.id)}><Icon name="delete" size={16} />삭제</button>
            </div>
          </div>
        </>}
      </article>)}
    </div>}
    {compact && renderForm(draft, setDraft)}
    {compact && items.length > visibleItems.length && onShowAll && <button className="followup-show-more" disabled={!!busyId} onClick={showAll}>나머지 {items.length - visibleItems.length}건 더 보기 <Icon name="next" size={18} /></button>}
    {deletionId && <DeletionDialog type="followup" id={deletionId} onClose={() => setDeletionId(null)} onBusyChange={(busy) => { mutationLock.current = busy; setBusyId(busy ? deletionId : null); busyCallback.current?.(busy); }} onDeleted={() => {
      setDeletionId(null);
      setNotice("할 일을 휴지통으로 옮겼습니다. 휴지통에서 복구할 수 있습니다.");
      setMutationError("");
      void reload();
      onChange?.();
    }} />}
  </section>;
}
