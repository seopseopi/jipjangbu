"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./icons";
import { clientJsonFetch as jsonFetch } from "./client-api";

export type Lookups = {
  workTypes: string[];
  propertyTypes: string[];
  buildings: Array<{
    id: string;
    property_type: string;
    building_name: string;
  }>;
};
type BackupSummary = {
  key: string;
  kind: "daily" | "changes" | "manual";
  createdAt: string;
  size: number;
  reason: string;
};

function SettingsView({
  lookups,
  onSaved,
  onLogout,
}: {
  lookups: Lookups;
  onSaved: () => Promise<void>;
  onLogout: () => void;
}) {
  const [kind, setKind] = useState("workType");
  const [propertyType, setPropertyType] = useState(
    lookups.propertyTypes[0] || "아파트",
  );
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const requestPending = useRef(false);
  async function refreshSavedLookups() {
    setRefreshError("");
    try {
      await onSaved();
    } catch {
      setRefreshError("분류는 추가되었지만 목록을 다시 불러오지 못했습니다. 다시 추가할 필요는 없습니다. 목록만 다시 불러와 주세요.");
    }
  }
  async function retryRefresh() {
    if (requestPending.current) return;
    requestPending.current = true;
    setSaving(true);
    try {
      await refreshSavedLookups();
    } finally {
      requestPending.current = false;
      setSaving(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (requestPending.current) return;
    requestPending.current = true;
    setSaving(true);
    setError("");
    setSavedMessage("");
    setRefreshError("");
    try {
      await jsonFetch("/api/lookups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, propertyType, name }),
      });
      setName("");
      setSavedMessage(`‘${name.trim()}’ 분류를 추가했습니다.`);
      await refreshSavedLookups();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      requestPending.current = false;
      setSaving(false);
    }
  }
  return (
    <div className="settings-grid">
      <section className="panel settings-panel">
        <div className="panel-head">
          <div>
            <h2>업무구분</h2>
          </div>
          <span className="count-badge">{lookups.workTypes.length}</span>
        </div>
        <div className="chip-list">
          {lookups.workTypes.map((type) => (
            <span key={type}>{type}</span>
          ))}
        </div>
      </section>
      <section className="panel settings-panel">
        <div className="panel-head">
          <div>
            <h2>물건·건물 분류</h2>
          </div>
          <span className="count-badge">{lookups.buildings.length}</span>
        </div>
        <div className="building-groups">
          {lookups.propertyTypes.map((type) => (
            <details key={type}>
              <summary>
                <Icon name="next" size={18} />
                <span>{type}</span>
                <small>
                  {
                    lookups.buildings.filter(
                      (item) => item.property_type === type,
                    ).length
                  }
                  개
                </small>
              </summary>
              <ul className="building-name-list">
                {lookups.buildings
                  .filter((item) => item.property_type === type)
                  .map((item) => <li key={item.id}>{item.building_name}</li>)}
              </ul>
            </details>
          ))}
        </div>
      </section>
      <form className="panel add-setting" onSubmit={submit}>
        <div>
          <h2>새 분류 추가</h2>
        </div>
        <label>
          분류 <b className="required-mark" aria-hidden="true">*</b>
          <select
            value={kind}
            aria-required="true"
            disabled={saving}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="workType">업무구분</option>
            <option value="building">건물명</option>
          </select>
        </label>
        {kind === "building" && (
          <label>
            물건구분 <b className="required-mark" aria-hidden="true">*</b>
            <select
              value={propertyType}
              aria-required="true"
              disabled={saving}
              onChange={(event) => setPropertyType(event.target.value)}
            >
              {lookups.propertyTypes.map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          이름 <b className="required-mark" aria-hidden="true">*</b>
          <input
            value={name}
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        {savedMessage && <div className="form-help" role="status">{savedMessage}</div>}
        {refreshError && <div className="form-error" role="alert"><p>{refreshError}</p><button type="button" className="secondary-button" onClick={retryRefresh} disabled={saving}><Icon name="refresh" size={17} /> 목록 다시 불러오기</button></div>}
        <button className="primary-button" disabled={saving}>
          {saving ? savedMessage ? "목록 불러오는 중…" : "추가 중…" : "추가"}
        </button>
      </form>
      <BackupPanel />
      <section className="panel account-panel">
        <div>
          <h2>관리자 계정</h2>
          <p>현재 기기에서 안전하게 로그아웃합니다.</p>
        </div>
        <button className="secondary-button" type="button" onClick={onLogout}>
          로그아웃
        </button>
      </section>
    </div>
  );
}

function BackupPanel() {
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [downloadKey, setDownloadKey] = useState("");
  const [visibleCount, setVisibleCount] = useState(12);
  const loadVersion = useRef(0);
  const creatingRef = useRef(false);
  const downloadingRef = useRef(false);
  const createdListPending = useRef(false);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setLoadError("");
    try {
      const data = await jsonFetch<{ backups: BackupSummary[] }>(
        "/api/backups",
      );
      if (version !== loadVersion.current) return false;
      setBackups([...data.backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      if (createdListPending.current) {
        createdListPending.current = false;
        setMessage("새 백업 목록을 확인했습니다. 아래 최신 백업에서 내려받을 수 있습니다.");
      }
      return true;
    } catch (error) {
      if (version === loadVersion.current)
        setLoadError(error instanceof Error ? error.message : "백업 목록을 불러오지 못했습니다.");
      return false;
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      loadVersion.current += 1;
    };
  }, [load]);
  async function createNow() {
    if (creatingRef.current) return;
    creatingRef.current = true;
    createdListPending.current = false;
    setCreating(true);
    setMessage("");
    setActionError("");
    try {
      await jsonFetch("/api/backups", { method: "POST" });
      const refreshed = await load();
      createdListPending.current = !refreshed;
      setMessage(refreshed
        ? "새 백업을 만들었습니다. 아래 최신 백업에서 내려받을 수 있습니다."
        : "새 백업은 만들어졌지만 목록을 확인하지 못했습니다. 아래 ‘다시 불러오기’로 최신 백업을 확인해 주세요.");
    } catch (backupError) {
      setActionError(backupError instanceof Error ? backupError.message : "백업을 만들지 못했습니다.");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }
  async function download(backup: BackupSummary) {
    if (downloadingRef.current) return;
    downloadingRef.current = true;
    createdListPending.current = false;
    setDownloadKey(backup.key);
    setActionError("");
    setMessage("");
    try {
      const response = await fetch(`/api/backups/download?key=${encodeURIComponent(backup.key)}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || "백업 파일을 내려받지 못했습니다. 다시 시도해 주세요.");
      }
      if (!response.headers.get("Content-Type")?.includes("application/json"))
        throw new Error("백업 파일을 확인하지 못했습니다. 로그인 상태를 확인한 뒤 다시 시도해 주세요.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `jipjangbu-backup-${backup.createdAt.slice(0, 10)}-${backup.kind}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setMessage("백업 파일을 준비했습니다. 브라우저의 다운로드 목록에서 저장 여부를 확인해 주세요.");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "백업 파일을 내려받지 못했습니다.");
    } finally {
      downloadingRef.current = false;
      setDownloadKey("");
    }
  }
  const kindLabel = (backup: BackupSummary) =>
    backup.kind === "daily"
      ? "일일 자동"
      : backup.kind === "manual"
        ? "직접 저장"
        : backup.reason.startsWith("post-")
          ? "변경 후 자동"
          : "변경 전 자동";
  const dateTime = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "날짜 정보 없음";
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  };
  return (
    <section className="panel backup-panel">
      <div className="backup-head">
        <div>
          <h2>데이터 안전 백업</h2>
          <span>
            이용 시 일일 백업과 정보 변경 전·후 백업을 암호화해 보관합니다.
            예약 실행은 배포 환경에 따라 적용되며, 90일이 지난 백업은 정리합니다.
          </span>
        </div>
        <button
          className="primary-button"
          type="button"
          onClick={createNow}
          disabled={creating}
        >
          <Icon name="backup" size={18} />
          {creating ? "백업 중…" : "지금 백업"}
        </button>
      </div>
      {message && (
        <p className="backup-message" role="status">
          {message}
        </p>
      )}
      {actionError && <p className="backup-action-error" role="alert">{actionError}</p>}
      {loadError && (
        <div className="backup-load-error" role="alert">
          <div><strong>백업 목록을 확인하지 못했습니다.</strong><p>{loadError}</p></div>
          <button className="secondary-button" type="button" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" size={17} /> 다시 불러오기
          </button>
        </div>
      )}
      {backups[0] && (
        <div className="backup-latest">
          <Icon name="backup" size={19} />
          <span>{loadError || loading ? "마지막으로 확인한 백업" : "가장 최근 백업"}<strong>{dateTime(backups[0].createdAt)}</strong></span>
        </div>
      )}
      <p className="backup-download-help">내려받은 파일에는 고객 정보가 포함됩니다. 안전한 곳에 보관해 주세요. 전체 데이터를 담는 복구용 파일입니다.</p>
      <div className="backup-list" aria-busy={loading}>
        {loading ? (
          <p className="backup-empty" role="status">백업 목록을 불러오는 중입니다.</p>
        ) : backups.length === 0 && !loadError ? (
          <p className="backup-empty">아직 만들어진 백업이 없습니다.</p>
        ) : (
          backups.slice(0, visibleCount).map((backup) => (
            <div className="backup-row" key={backup.key}>
              <div>
                <strong>{kindLabel(backup)}</strong>
                <span>
                  <time className="record-date" dateTime={backup.createdAt}>{dateTime(backup.createdAt)}</time> ·{" "}
                  {Math.max(1, Math.round(backup.size / 1024)).toLocaleString(
                    "ko-KR",
                  )}
                  KB
                </span>
              </div>
              <button
                className="tiny-button"
                type="button"
                disabled={Boolean(downloadKey)}
                onClick={() => void download(backup)}
                aria-label={`${dateTime(backup.createdAt)} ${kindLabel(backup)} 백업 내려받기`}
              >
                <Icon name={downloadKey === backup.key ? "refresh" : "download"} size={16} />
                {downloadKey === backup.key ? "준비 중…" : "내려받기"}
              </button>
            </div>
          ))
        )}
      </div>
      {!loading && visibleCount < backups.length && (
        <button
          className="backup-show-more"
          type="button"
          onClick={() => setVisibleCount((count) => count + 24)}
        >
          이전 백업 더 보기{" "}
          <small>{backups.length - visibleCount}개 남음</small>
        </button>
      )}
    </section>
  );
}

export { SettingsView };
