"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clientJsonFetch } from "./client-api";
import type { DeletionEntityType, RestoreResult, TrashDetailResponse, TrashListResponse } from "./deletion-types";
import { deletionTypeLabel, DeletionPreviewContent, SafetyDialog } from "./deletion-dialog";
import { formatHistoryTimestamp } from "./history-timestamps";
import { Icon } from "./icons";

function trashError(error: unknown) {
  return error instanceof Error ? error.message : "휴지통을 확인하지 못했습니다. 다시 시도해 주세요.";
}

export function TrashView({ refreshKey = 0, onRestored, onBusyChange }: {
  refreshKey?: number;
  onRestored: (result: RestoreResult) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [type, setType] = useState<DeletionEntityType | "">("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [data, setData] = useState<TrashListResponse | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TrashDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [purgeMode, setPurgeMode] = useState(false);
  const [purgeConfirmed, setPurgeConfirmed] = useState(false);
  const [purging, setPurging] = useState(false);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [bulkDetails, setBulkDetails] = useState<TrashDetailResponse[] | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkError, setBulkError] = useState("");
  const [bulkConfirmed, setBulkConfirmed] = useState(false);
  const listRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const pageLock = useRef(false);
  const restoreLock = useRef(false);
  const busyCallback = useRef(onBusyChange);
  const queryKey = JSON.stringify([type, query.trim()]);
  const settledKey = JSON.stringify([type, search]);
  const showingCurrent = loadedKey === queryKey;
  useEffect(() => { busyCallback.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => () => { listRequest.current?.abort(); detailRequest.current?.abort(); busyCallback.current?.(false); }, []);
  useEffect(() => { const timer = window.setTimeout(() => setSearch(query.trim()), 250); return () => window.clearTimeout(timer); }, [query]);

  const load = useCallback(async () => {
    setCheckedIds([]);
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    pageLock.current = false;
    setLoadingMore(false);
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: "50", offset: "0" });
      if (type) params.set("type", type);
      if (search) params.set("q", search);
      const response = await clientJsonFetch<TrashListResponse>(`/api/trash?${params}`, { signal: controller.signal, cache: "no-store" });
      if (!controller.signal.aborted) { setData(response); setLoadedKey(settledKey); }
    } catch (failure) {
      if (!controller.signal.aborted) setError(trashError(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [type, search, settledKey]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => { window.clearTimeout(timer); listRequest.current?.abort(); };
  }, [load, refreshKey]);

  async function loadMore() {
    if (pageLock.current || loading || !showingCurrent || !data || data.items.length >= data.total) return;
    pageLock.current = true;
    setLoadingMore(true);
    setError("");
    const controller = listRequest.current;
    try {
      const params = new URLSearchParams({ limit: "50", offset: String(data.items.length) });
      if (type) params.set("type", type);
      if (search) params.set("q", search);
      const response = await clientJsonFetch<TrashListResponse>(`/api/trash?${params}`, { signal: controller?.signal, cache: "no-store" });
      if (!controller?.signal.aborted && listRequest.current === controller) setData((current) => current ? { ...response, items: [...current.items, ...response.items.filter((item) => !current.items.some((existing) => existing.id === item.id))] } : response);
    } catch (failure) {
      if (!controller?.signal.aborted) setError(trashError(failure));
    } finally {
      if (listRequest.current === controller) { pageLock.current = false; setLoadingMore(false); }
    }
  }

  async function openBulk() {
    if (restoreLock.current || !checkedIds.length || !showingCurrent) return;
    restoreLock.current = true;
    setBulkLoading(true); setBulkError(""); setBulkConfirmed(false); setBulkDetails([]);
    busyCallback.current?.(true);
    try {
      const details: TrashDetailResponse[] = [];
      for (let offset = 0; offset < checkedIds.length; offset += 10) details.push(...await Promise.all(checkedIds.slice(offset, offset + 10).map(id => clientJsonFetch<TrashDetailResponse>(`/api/trash/${encodeURIComponent(id)}`, { cache: "no-store" }))));
      setBulkDetails(details);
    } catch (failure) { setBulkError(trashError(failure)); }
    finally { restoreLock.current = false; setBulkLoading(false); busyCallback.current?.(false); }
  }

  async function purgeBulk() {
    if (restoreLock.current || !bulkConfirmed || !bulkDetails?.length || bulkError) return;
    restoreLock.current = true; setPurging(true); busyCallback.current?.(true);
    try {
      const result = await clientJsonFetch<{ deletedCount: number }>("/api/trash", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: bulkDetails.map(d => ({ id: d.item.id, revision: d.preview.revision })) }) });
      setBulkDetails(null); setCheckedIds([]); setNotice(`${result.deletedCount}건을 휴지통에서 영구 삭제했습니다. 휴지통에서는 복구할 수 없습니다.`);
      void load();
    } catch (failure) { setBulkError(trashError(failure)); setBulkConfirmed(false); }
    finally { restoreLock.current = false; setPurging(false); busyCallback.current?.(false); }
  }

  async function openDetail(id: string) {
    if (restoreLock.current) return;
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    setDetailError("");
    setPurgeMode(false);
    setPurgeConfirmed(false);
    try {
      const response = await clientJsonFetch<TrashDetailResponse>(`/api/trash/${encodeURIComponent(id)}`, { signal: controller.signal, cache: "no-store" });
      if (!controller.signal.aborted) setDetail(response);
    } catch (failure) {
      if (!controller.signal.aborted) setDetailError(trashError(failure));
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  }

  function closeDetail() {
    if (restoreLock.current) return;
    detailRequest.current?.abort();
    setSelectedId(null);
    setDetail(null);
  }

  async function restore() {
    if (restoreLock.current || !detail || detailLoading) return;
    restoreLock.current = true;
    setRestoring(true);
    busyCallback.current?.(true);
    setDetailError("");
    let result: RestoreResult;
    try {
      result = await clientJsonFetch<RestoreResult>(`/api/trash/${encodeURIComponent(detail.item.id)}/restore`, { method: "POST" });
    } catch (failure) {
      setDetailError(trashError(failure));
      return;
    } finally {
      restoreLock.current = false;
      setRestoring(false);
      busyCallback.current?.(false);
    }
    closeDetail();
    setNotice(`${deletionTypeLabel(result.type)} 기록을 복구했습니다. 원래 목록에서 확인할 수 있습니다.`);
    onRestored(result);
    // This reload owns its error state; restoration has already succeeded.
    void load();
  }

  async function purge() {
    if (restoreLock.current || !detail || detailLoading || !purgeMode || !purgeConfirmed) return;
    restoreLock.current = true;
    setPurging(true);
    busyCallback.current?.(true);
    setDetailError("");
    try {
      await clientJsonFetch(`/api/trash/${encodeURIComponent(detail.item.id)}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: detail.preview.revision }),
      });
    } catch (failure) {
      setDetailError(trashError(failure));
      return;
    } finally {
      restoreLock.current = false;
      setPurging(false);
      busyCallback.current?.(false);
    }
    closeDetail();
    setNotice("선택한 기록을 휴지통에서 영구 삭제했습니다. 휴지통에서는 복구할 수 없습니다.");
    void load();
  }

  return <section className="trash-view" aria-label="휴지통">
    <p className="trash-help">휴지통은 자동으로 비워지지 않습니다.</p>
    <div className="trash-controls">
      <label className="trash-search"><Icon name="search" size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="삭제한 기록 검색" aria-label="휴지통 검색" />{query && <button type="button" aria-label="휴지통 검색 지우기" onClick={() => setQuery("")}><Icon name="close" size={17} /></button>}</label>
      <label className="trash-type"><span>기록 종류</span><select value={type} onChange={(event) => setType(event.target.value as DeletionEntityType | "")}><option value="">모든 기록</option><option value="work">업무</option><option value="customer">고객</option><option value="followup">할 일</option></select></label>
      <button type="button" className="secondary-button" disabled={loading || loadingMore} onClick={() => void load()}><Icon name="refresh" size={17} />새로고침</button>
    </div>
    {notice && <p className="trash-notice" role="status">{notice}</p>}
    {error && <div className="deletion-error" role="alert"><p>휴지통 목록을 불러오지 못했습니다. {error}</p><button type="button" className="secondary-button" onClick={() => void load()} disabled={loading}>다시 불러오기</button></div>}
    {loading || (!showingCurrent && !error) ? <p className="trash-empty" role="status">휴지통을 불러오고 있습니다…</p> : showingCurrent && data ? <>
      <div className="trash-list-heading"><h2>삭제한 기록 <span>{data.total.toLocaleString("ko-KR")}건</span></h2><p>삭제일 최신순 · 내용 확인 후 복구 또는 영구 삭제</p></div>
      {data.items.length > 0 && <div className="trash-bulk-controls">
        <label><input type="checkbox" checked={data.items.every(item => checkedIds.includes(item.id))} onChange={event => setCheckedIds(event.target.checked ? data.items.map(item => item.id) : [])} /> 현재 표시된 {data.items.length}건 전체 선택</label>
        <button type="button" className="danger-button" disabled={!checkedIds.length || checkedIds.length > 500} onClick={() => void openBulk()}>선택한 {checkedIds.length}건 영구 삭제</button>
        <small>더 보기로 불러온 기록도 선택할 수 있습니다. 한 번에 최대 500건.</small>
      </div>}
      {data.items.length === 0 ? <div className="trash-empty"><Icon name={query || type ? "search" : "empty"} size={28} /><strong>{query || type ? "조건에 맞는 삭제 기록이 없습니다." : "휴지통이 비어 있습니다."}</strong>{(query || type) && <button type="button" className="secondary-button" onClick={() => { setQuery(""); setSearch(""); setType(""); }}>검색 조건 초기화</button>}</div>
        : <ol className="trash-list">{data.items.map((item) => <li key={item.id} className="trash-selectable"><input type="checkbox" aria-label={`${item.title} 삭제 선택`} checked={checkedIds.includes(item.id)} onChange={event => setCheckedIds(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))} /><button type="button" className="trash-record" onClick={() => void openDetail(item.id)}>
          <span className="trash-kind">{deletionTypeLabel(item.type)}</span><span className="trash-record-main"><strong>{item.title}</strong><span>{item.subtitle}</span></span>
          <span className="trash-record-action"><time dateTime={item.deletedAt}>삭제 · {formatHistoryTimestamp(item.deletedAt)}</time><span>내용 확인 · 복구 · 영구 삭제</span></span>
        </button></li>)}</ol>}
      {data.items.length < data.total && <button type="button" className="secondary-button trash-more" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "불러오는 중…" : `이전 삭제 기록 더 보기 (${data.items.length.toLocaleString("ko-KR")} / ${data.total.toLocaleString("ko-KR")})`}</button>}
    </> : null}
    {selectedId && <SafetyDialog title={purgeMode ? "영구 삭제 확인" : "삭제한 기록 확인 · 복구"} busy={restoring || purging} onClose={closeDetail} actions={purgeMode ? <>
      <button type="button" className="secondary-button" disabled={purging} onClick={() => { setPurgeMode(false); setPurgeConfirmed(false); }}>돌아가기</button>
      <button type="button" className="danger-button" disabled={purging || !purgeConfirmed || !detail || detailLoading} onClick={() => void purge()}>{purging ? "삭제 중…" : "영구 삭제 확정"}</button>
    </> : <>
      <button type="button" className="danger-button" disabled={restoring || detailLoading || !detail} onClick={() => { setPurgeMode(true); setPurgeConfirmed(false); }}>영구 삭제</button>
      <button type="button" className="primary-button" disabled={restoring || detailLoading || !detail} onClick={() => void restore()}><Icon name={restoring ? "clock" : "restore"} size={18} />{restoring ? "복구 중…" : "이 기록 복구"}</button>
    </>}>
      {purgeMode ? <div className="deletion-error"><p>이 기록을 휴지통에서 영구 삭제합니다. 휴지통에서는 다시 복구할 수 없습니다. 현재 업무·고객·매물은 삭제하지 않습니다.</p><p>기존 암호화 안전 백업은 보관 기간 동안 유지됩니다.</p><label><input type="checkbox" checked={purgeConfirmed} disabled={purging} onChange={event => setPurgeConfirmed(event.target.checked)} /> 복구할 수 없음을 확인했습니다.</label></div> : <p className="deletion-explanation">내용을 확인하고 복구해 주세요. 업무는 원래 업무일로 돌아가며, 다른 업무나 현재 고객 정보를 덮어쓰지 않습니다.</p>}
      {detailLoading && <p role="status">삭제한 내용을 불러오고 있습니다…</p>}
      {detail && <><p className="trash-deleted-time">삭제 · {formatHistoryTimestamp(detail.item.deletedAt)}</p><DeletionPreviewContent preview={purgeMode ? { ...detail.preview, warnings: [] } : detail.preview} restoring /></>}
      {detailError && <div className="deletion-error" role="alert"><p>{detailError}</p><button type="button" className="secondary-button" disabled={restoring || purging || detailLoading} onClick={() => void openDetail(selectedId)}>내용 다시 확인</button></div>}
    </SafetyDialog>}
    {bulkDetails !== null && <SafetyDialog title="선택한 기록 영구 삭제" busy={bulkLoading || purging} onClose={() => { if (!restoreLock.current) setBulkDetails(null); }} actions={<button type="button" className="danger-button" disabled={bulkLoading || purging || !bulkConfirmed || !bulkDetails.length || !!bulkError} onClick={() => void purgeBulk()}>{purging ? "삭제 중…" : `${bulkDetails.length}건 영구 삭제 확정`}</button>}>
      <p>선택한 기록만 삭제합니다. 현재 업무·고객·매물은 삭제하지 않으며, 기존 암호화 백업은 보관 기간 동안 유지됩니다.</p>
      {bulkLoading ? <p role="status">선택한 기록을 확인하고 있습니다…</p> : <ul className="trash-bulk-preview">{bulkDetails.map(({ item }) => <li key={item.id}><strong>{deletionTypeLabel(item.type)} · {item.title}</strong><span>{item.subtitle}</span></li>)}</ul>}
      {bulkError && <p className="deletion-error" role="alert">{bulkError} 취소 후 목록을 새로고침하고 다시 선택해 주세요.</p>}
      <label><input type="checkbox" checked={bulkConfirmed} disabled={bulkLoading || purging || !!bulkError} onChange={event => setBulkConfirmed(event.target.checked)} /> 선택한 {bulkDetails.length}건을 휴지통에서 복구할 수 없음을 확인했습니다.</label>
    </SafetyDialog>}
  </section>;
}
