"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { clientJsonFetch } from "./client-api";
import type { DeletionEntityType, DeletionPreview, DeletionResult } from "./deletion-types";
import { Icon } from "./icons";

export function deletionTypeLabel(type: DeletionEntityType) {
  return type === "work" ? "업무" : type === "customer" ? "고객" : "할 일";
}

export function deletionEndpoint(type: DeletionEntityType, id: string) {
  const collection = type === "work" ? "work-logs" : type === "customer" ? "customers" : "follow-ups";
  return `/api/${collection}/${encodeURIComponent(id)}`;
}

function failureMessage(error: unknown) {
  if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return "서버 응답을 받지 못했습니다. 연결 상태를 확인해 주세요. 이미 처리되었는지는 휴지통에서 확인할 수 있습니다.";
  return error instanceof Error ? error.message : "처리하지 못했습니다. 다시 시도해 주세요.";
}

/** Native modal isolation keeps the underlying reader/editor and its draft intact. */
export function SafetyDialog({ title, busy, onClose, children, actions }: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog?.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  useEffect(() => {
    // A disabled submit button can leave focus on <body>. Capture at window,
    // not only inside the dialog, so Escape never reaches the parent editor.
    const isolateKeys = (event: KeyboardEvent) => {
      if (!dialogRef.current?.open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!busy) onClose();
      } else if (event.key === "Tab") event.stopPropagation();
    };
    window.addEventListener("keydown", isolateKeys, true);
    return () => window.removeEventListener("keydown", isolateKeys, true);
  }, [busy, onClose]);
  useEffect(() => {
    if (!busy) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [busy]);
  return <dialog ref={dialogRef} className="safety-dialog" aria-modal="true" aria-label={title} aria-busy={busy}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}
    onKeyDownCapture={(event) => {
      // Existing read/edit overlays have their own document key handlers.
      if (event.key === "Escape" || event.key === "Tab") event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); if (!busy) onClose(); }
    }}>
    <header className="safety-dialog-heading"><h2>{title}</h2></header>
    <div className="safety-dialog-body">{children}</div>
    <footer className="safety-dialog-actions">
      <button ref={cancelRef} type="button" className="secondary-button" disabled={busy} onClick={onClose}>취소</button>
      {actions}
    </footer>
  </dialog>;
}

export function DeletionPreviewContent({ preview, restoring = false }: { preview: DeletionPreview; restoring?: boolean }) {
  return <div className="deletion-preview">
    <div className="deletion-record-heading"><strong>{preview.title}</strong><p>{preview.subtitle}</p></div>
    <section aria-label="저장된 내용"><h3>저장된 내용</h3><p className="deletion-record-content">{preview.content || "기록된 내용이 없습니다."}</p></section>
    {preview.affectedListings.length > 0 && <section aria-label="연결된 모든 매물">
      <h3>연결 매물 <span>{preview.affectedListings.length}개</span></h3>
      <ol className="deletion-listings">{preview.affectedListings.map((listing, index) => <li key={`${listing.key}-${index}`}>{listing.label}</li>)}</ol>
    </section>}
    {preview.warnings.length > 0 && <ul className="deletion-warnings">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {!restoring && preview.blockedReason && <p className="deletion-blocked" role="alert"><Icon name="warning" size={19} /><span>{preview.blockedReason}</span></p>}
  </div>;
}

export function DeletionDialog({ type, id, unsavedDraft = false, onClose, onDeleted, onBusyChange }: {
  type: DeletionEntityType;
  id: string;
  unsavedDraft?: boolean;
  onClose: () => void;
  onDeleted: (result: DeletionResult) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mustRecheck, setMustRecheck] = useState(false);
  const mutationLock = useRef(false);
  const request = useRef<AbortController | null>(null);
  const busyCallback = useRef(onBusyChange);
  useEffect(() => { busyCallback.current = onBusyChange; }, [onBusyChange]);
  useEffect(() => () => { request.current?.abort(); busyCallback.current?.(false); }, []);
  const loadPreview = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    setPreview(null);
    try {
      const result = await clientJsonFetch<{ preview: DeletionPreview }>(`/api/deletions/preview?${new URLSearchParams({ type, id })}`, { signal: controller.signal, cache: "no-store" });
      if (!controller.signal.aborted) { setPreview(result.preview); setMustRecheck(false); }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failureMessage(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [type, id]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void loadPreview(); }, 0);
    return () => { window.clearTimeout(timer); request.current?.abort(); };
  }, [loadPreview]);

  async function moveToTrash() {
    if (mutationLock.current || loading || !preview || preview.blockedReason || mustRecheck) return;
    mutationLock.current = true;
    busyCallback.current?.(true);
    setBusy(true);
    setError("");
    let result: DeletionResult;
    try {
      result = await clientJsonFetch<DeletionResult>(deletionEndpoint(type, id), {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: preview.revision }),
      });
    } catch (failure) {
      if ((failure as { status?: number })?.status === 409) setMustRecheck(true);
      setError(failureMessage(failure));
      return;
    } finally {
      mutationLock.current = false;
      setBusy(false);
      busyCallback.current?.(false);
    }
    // A list refresh failure must never be presented as a failed deletion.
    onDeleted(result);
  }

  function requestClose() { if (!mutationLock.current) onClose(); }
  return <SafetyDialog title={`${deletionTypeLabel(type)} 삭제 확인`} busy={busy} onClose={requestClose} actions={
    <button type="button" className="danger-button" disabled={busy || loading || !preview || !!preview.blockedReason || mustRecheck} onClick={() => void moveToTrash()}>
      <Icon name={busy ? "clock" : "delete"} size={18} />{busy ? "휴지통으로 옮기는 중…" : "휴지통으로 이동"}
    </button>
  }>
    <p className="deletion-explanation">삭제한 기록은 휴지통에서 다시 복구할 수 있습니다. 휴지통은 자동으로 비우지 않습니다.</p>
    {unsavedDraft && <p className="deletion-draft-warning">아래는 저장된 기록입니다. 아직 저장하지 않은 수정 내용은 휴지통에 포함되지 않습니다. 취소하면 작성 중인 내용으로 돌아갑니다.</p>}
    {loading && <p role="status">삭제할 내용과 연결된 기록을 확인하고 있습니다…</p>}
    {preview && <DeletionPreviewContent preview={preview} />}
    {error && <div className="deletion-error" role="alert"><p>{error}</p>
      {(mustRecheck || !preview) ? <button type="button" className="secondary-button" disabled={loading || busy} onClick={() => void loadPreview()}><Icon name="refresh" size={17} />{mustRecheck ? "최신 내용 다시 확인" : "다시 불러오기"}</button>
        : <p>현재 화면은 유지됩니다. 내용을 확인하고 다시 시도해 주세요.</p>}
    </div>}
    {mustRecheck && <p className="deletion-draft-warning">기록이 변경되었습니다. 최신 내용을 다시 확인한 뒤 휴지통으로 이동해 주세요.</p>}
  </SafetyDialog>;
}
