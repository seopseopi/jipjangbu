"use client";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { FileCheck2, Layers3, Settings2 } from "lucide-react";
import { clientJsonFetch, clearClientReadCache } from "../client-api";
import { PlanViewer } from "./plan-viewer";
import {
  ApartmentSourcePanel,
  type SourceSelection,
} from "./apartment-source-panel";
import { StructureManager } from "./structure-manager";
import {
  linkedStructureUnit,
  structureGroups,
  structurePropertyDong,
  structureGroupKey,
  structureConnectionIssue,
} from "./catalog";
import type { Catalog, History, PropertyRow, RevisionData } from "./contracts";
const PlanWorkbench = lazy(() =>
  import("./plan-workbench").then((m) => ({ default: m.PlanWorkbench })),
);
const natural = new Intl.Collator("ko", { numeric: true });
const emptyCatalog: Catalog = {
  properties: [],
  complexes: [],
  units: [],
  revisions: [],
  links: [],
};
export function StructureView({
  initialKey = "",
  refreshKey = 0,
  onOpenWork,
}: {
  initialKey?: string;
  refreshKey?: number;
  onOpenWork: (id: string) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [complex, setComplex] = useState(""),
    [dong, setDong] = useState(""),
    [key, setKey] = useState(initialKey),
    [manager, setManager] = useState(false),
    [sourceSelection, setSourceSelection] = useState<
      SourceSelection | undefined
    >(),
    [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    clientJsonFetch<Catalog>("/api/structures", { signal: controller.signal })
      .then((data) => {
        setCatalog(data);
        setLoading(false);
        setError("");
        const selected = key;
        const p = data.properties.find((p) => p.identity_key === selected);
        const u = selected.startsWith("unit:")
          ? data.units.find((u) => u.id === selected.slice(5))
          : linkedStructureUnit(data, selected);
        if (u) {
          setComplex(`complex:${u.complex_id}`);
          setDong(u.building_name);
        } else if (p) {
          setComplex(structureGroupKey(data, p));
          setDong(p.building_dong);
        }
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [initialKey, refreshKey, generation, key]);
  useEffect(() => {
    const refresh = () => {
      clearClientReadCache();
      setGeneration((n) => n + 1);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const property = catalog.properties.find((p) => p.identity_key === key);
  const linkedUnit = catalog.links.find((l) => l.identity_key === key)?.unit_id;
  const unit = catalog.units.find(
    (u) => u.id === (key.startsWith("unit:") ? key.slice(5) : linkedUnit),
  );
  const groups = useMemo(
    () =>
      structureGroups(catalog).sort(
        (a, b) =>
          natural.compare(a.name, b.name) ||
          natural.compare(a.address, b.address),
      ),
    [catalog],
  );
  const selectedGroup = groups.find((g) => g.key === complex);
  const properties = selectedGroup?.properties ?? [];
  const registeredUnits = selectedGroup?.units ?? [];
  const dongs = [
    ...new Set([
      ...properties.map((p) => structurePropertyDong(catalog, p)),
      ...registeredUnits.map((u) => u.building_name),
    ]),
  ].sort(natural.compare);
  const selectedProperties = properties.filter(
    (p) => structurePropertyDong(catalog, p) === dong,
  );
  const selectedUnits = registeredUnits.filter(
    (u) =>
      u.building_name === dong &&
      !catalog.links.some(
        (l) =>
          l.unit_id === u.id &&
          selectedProperties.some((p) => p.identity_key === l.identity_key),
      ),
  );
  const saved = (focusKey?: string) => {
    if (focusKey) setKey(focusKey);
    clearClientReadCache();
    setGeneration((n) => n + 1);
    setManager(false);
    setSourceSelection(undefined);
  };
  return (
    <div className="structures structure-fit-screen">
      <div className="structure-selectors">
        <label>
          단지
          <select
            aria-label="단지 선택"
            value={complex}
            disabled={loading}
            onChange={(e) => {
              setComplex(e.target.value);
              setDong("");
              setKey("");
              setManager(false);
              setSourceSelection(undefined);
            }}
          >
            <option value="">단지 선택</option>
            {groups.map((g) => (
              <option key={g.key} value={g.key}>
                {g.name}
                {g.key.startsWith("complex:") ? ` · ${g.address}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          동
          <select
            aria-label="동 선택"
            value={dong}
            disabled={!complex || !dongs.length}
            onChange={(e) => {
              setDong(e.target.value);
              setKey("");
              setManager(false);
            }}
          >
            <option value="">동 선택</option>
            {dongs.map((d) => (
              <option key={d} value={d}>
                {d || "동 미기입"}
              </option>
            ))}
          </select>
        </label>
        <label>
          호수
          <select
            aria-label="호수 선택"
            value={key}
            disabled={
              !complex || (!selectedProperties.length && !selectedUnits.length)
            }
            onChange={(e) => {
              setKey(e.target.value);
              setManager(false);
            }}
          >
            <option value="">호수 선택</option>
            {selectedProperties.map((p) => (
              <option key={p.identity_key} value={p.identity_key}>
                {p.unit_number || "호수 미기입"}
                {p.size_types ? ` · ${p.size_types}` : ""}
              </option>
            ))}
            {selectedUnits.map((u) => (
              <option key={u.id} value={`unit:${u.id}`}>
                {u.number}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary-button"
          aria-label={manager ? "관리 닫기" : "도면 관리"}
          aria-pressed={manager}
          onClick={() => {
            setSourceSelection(undefined);
            setManager((v) => !v);
          }}
        >
          <Settings2 size={17} />
          <span>{manager ? "닫기" : "도면 관리"}</span>
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
          <button type="button" onClick={() => setGeneration((n) => n + 1)}>
            다시 불러오기
          </button>
        </p>
      )}
      {manager ? (
        <div className="structure-management-scroll">
          <StructureManager
            key={
              sourceSelection
                ? `${sourceSelection.source.alias}-${sourceSelection.type.id}-${sourceSelection.variant}`
                : key
            }
            sourceSelection={sourceSelection}
            catalog={catalog}
            property={property}
            unit={unit}
            onSaved={saved}
          />
        </div>
      ) : (
        <div className="structure-main">
          {!complex ? (
            <div className="structure-welcome">
              <Layers3 size={36} />
              <h3>단지를 선택하세요</h3>
            </div>
          ) : key ? (
            <UnitContent
              key={key}
              property={property}
              unit={unit}
              catalog={catalog}
              generation={generation + refreshKey}
              onManage={() => {
                setSourceSelection(undefined);
                setManager(true);
              }}
              onOpenWork={onOpenWork}
            />
          ) : (
            <ApartmentSourcePanel
              key={complex}
              name={selectedGroup?.name ?? ""}
              onRegister={(selection) => {
                setSourceSelection(selection);
                setManager(true);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function UnitContent({
  property,
  unit,
  catalog,
  generation,
  onManage,
  onOpenWork,
}: {
  property?: PropertyRow;
  unit?: Catalog["units"][number];
  catalog: Catalog;
  generation: number;
  onManage: () => void;
  onOpenWork: (id: string) => void;
}) {
  const [revision, setRevision] = useState<RevisionData | null>(null),
    [histories, setHistories] = useState<History[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [workType, setWorkType] = useState("");
  const keys = useMemo(
    () =>
      unit
        ? catalog.links
            .filter((l) => l.unit_id === unit.id)
            .map((l) => l.identity_key)
        : property
          ? [property.identity_key]
          : [],
    [unit, catalog.links, property],
  );
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      unit?.revision_id
        ? clientJsonFetch<RevisionData>(
            `/api/structures?revision=${encodeURIComponent(unit.revision_id)}`,
            { signal: controller.signal },
          )
        : Promise.resolve(null),
      Promise.all(
        keys.map((key) =>
          clientJsonFetch<History>(`/api/listings/${encodeURIComponent(key)}`, {
            signal: controller.signal,
          }),
        ),
      ),
    ])
      .then(([r, h]) => {
        setRevision(r);
        setHistories(h);
        setLoading(false);
        setError("");
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [unit?.revision_id, keys, generation]);
  const connectionIssue=structureConnectionIssue(catalog,property,unit);
  const records = [
    ...new Map(
      histories.flatMap((h) => h.workLogs).map((w) => [w.id, w]),
    ).values(),
  ].sort((a, b) => b.work_date.localeCompare(a.work_date));
  const retry = useCallback(() => {
    clearClientReadCache();
    window.dispatchEvent(new Event("focus"));
  }, []);
  return (
    <>
      {error && (
        <p className="form-error" role="alert">
          {error}
          <button type="button" onClick={retry}>
            다시 불러오기
          </button>
        </p>
      )}
      <div className="structure-detail structure-detail-simple">
        <section className="structure-plan-panel">
          {loading ||
          (unit?.revision_id && revision?.revision.id !== unit.revision_id) ? (
            <p className="structure-empty" role="status">
              세대 자료를 불러오는 중…
            </p>
          ) : revision ? (
            <>
              <h3
                className="structure-unit-title"
                title={`${unit?.complex_name ?? ""} ${unit?.building_name ?? ""} ${unit?.number ?? ""}`}
              >
                {unit?.complex_name} ·{" "}
                {unit
                  ? `${unit.building_name}${unit.building_name.endsWith("동") ? "" : "동"} ${unit.number}${unit.number.endsWith("호") ? "" : "호"}`
                  : ""}
              </h3>
              <div className="structure-plan-heading">
                <FileCheck2 size={18} />
                <strong>{revision.revision.type_name}</strong>
                <span>
                  {revision.revision.variant === "base"
                    ? "기본형"
                    : revision.revision.variant === "expanded"
                      ? "확장형"
                      : "리모델링"}
                </span>
              </div>
              <p className="structure-notice">
                {unit?.evidence.startsWith("장부 평형 기준") && "장부 평형 기준 · 세대별 타입 미확인 · "}
                {unit?.actual_condition === "unknown"
                  ? "실제 확장·리모델링 여부 미확인"
                  : `실제 상태: ${unit?.actual_condition === "base" ? "기본형" : unit?.actual_condition === "expanded" ? "확장" : "리모델링"}`}{" "}
                ·{" "}
                {unit?.mirror == null || unit?.rotation == null
                  ? "세대 방향 미확인 · 타입 기준 배치"
                  : "확인된 타입 기준 배치 · 방위 정보 없음"}
                {unit?.actual_condition !== "unknown" &&
                unit?.actual_condition !== revision.revision.variant
                  ? " · 실제 상태와 도면 구분이 다릅니다. 참고용으로만 확인하세요."
                  : ""}
              </p>
              {connectionIssue ? <p className="structure-empty" role="alert">{connectionIssue}</p> : revision.file ? (
                <Suspense
                  fallback={<p role="status">도면을 준비하고 있습니다…</p>}
                >
                  <PlanWorkbench
                    key={`${revision.file.revision_id}:${revision.processing?.rowVersion ?? 0}`}
                    data={revision}
                    transform={{
                      mirror: unit?.mirror === 1,
                      rotation: unit?.rotation ?? 0,
                    }}
                  />
                </Suspense>
              ) : revision.plan ? (
                <PlanViewer
                  plan={revision.plan}
                  minimal
                  transform={{
                    mirror: unit?.mirror === 1,
                    rotation: unit?.rotation ?? 0,
                  }}
                />
              ) : (
                <p role="alert">도면 자료를 불러올 수 없습니다.</p>
              )}
              <details className="structure-source">
                <summary>도면 출처·확인 정보</summary>
                <p>{revision.revision.source}</p>
                <p>
                  {revision.plan?.dimensionEvidence.note ??
                    "원본 이미지·PDF · 실측 치수 및 3D 좌표는 등록되지 않았습니다."}
                </p>
                <p>검증 기록: {revision.revision.verified_at}</p>
              </details>
            </>
          ) : (
            <div className="structure-empty-plan">
              <Layers3 size={36} />
              <h3>이 세대의 구조는 아직 확인되지 않았습니다</h3>
              <p>
                도면을 추측해서 표시하지 않습니다.
                <br />
                확인된 타입 도면을 등록하고 세대에 연결해 주세요.
              </p>
              <button
                className="secondary-button"
                type="button"
                onClick={onManage}
              >
                도면·세대 연결하기
              </button>
            </div>
          )}
        </section>
        <details className="structure-record-panel">
          <summary>업무 기록 ({records.length})</summary>
          {!loading && !histories.some((h) => h.listing) && (
            <p className="structure-help">
              현재 매물 상태 기록 없음 · 방문·상담 이력은 아래에서 확인하세요.
            </p>
          )}
          {histories.map(
            (h, i) =>
              h.listing && (
                <div className="structure-current" key={i}>
                  <strong>{h.listing.status}</strong>
                  <p>
                    {[
                      h.listing.sale_price && `매매 ${h.listing.sale_price}`,
                      h.listing.jeonse_price &&
                        `전세 ${h.listing.jeonse_price}`,
                      h.listing.monthly_rent &&
                        `월세 ${h.listing.monthly_rent}`,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "가격 미기입"}
                  </p>
                  <p>{h.listing.notes || "메모 없음"}</p>
                </div>
              ),
          )}
          <label className="structure-work-filter">
            업무 이력 {records.length}건
            <select
              value={workType}
              onChange={(e) => setWorkType(e.target.value)}
            >
              <option value="">전체 업무구분</option>
              {[...new Set(records.map((w) => w.work_type))].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <div className="structure-records">
            {records
              .filter((w) => !workType || w.work_type === workType)
              .map((w) => (
                <button
                  type="button"
                  key={w.id}
                  onClick={() => onOpenWork(w.id)}
                >
                  <span>
                    <time>{w.work_date}</time>
                    <strong>{w.work_type}</strong>
                  </span>
                  <span>
                    {w.customer_name} <small>{w.customer_id}</small>
                  </span>
                  <p>{w.content || "기록된 내용 없음"}</p>
                  <small>업무 내용 보기 →</small>
                </button>
              ))}
          </div>
          {!loading && !records.length && (
            <p className="structure-help">연결된 업무 기록이 없습니다.</p>
          )}
        </details>
      </div>
    </>
  );
}
