"use client";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Building2,
  Box,
  ChevronRight,
  FileCheck2,
  Layers3,
  Search,
  Settings2,
} from "lucide-react";
import { clientJsonFetch, clearClientReadCache } from "../client-api";
import { PlanViewer } from "./plan-viewer";
import { DEMO_PLAN } from "./plan";
import { apartmentSources, APARTMENT_SOURCES } from "./source-contract";
import {
  ApartmentSourcePanel,
  type SourceSelection,
} from "./apartment-source-panel";
import { StructureManager } from "./structure-manager";
import { RealPlanPreview } from "./real-plan-preview";
import {
  linkedStructureUnit,
  structureGroups,
  structurePropertyDong,
} from "./catalog";
import type { Catalog, History, PropertyRow, RevisionData } from "./contracts";
import "./structures.css";
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
    [search, setSearch] = useState(""),
    [complex, setComplex] = useState(""),
    [dong, setDong] = useState(""),
    [key, setKey] = useState(initialKey),
    [demo, setDemo] = useState(false),
    [reference, setReference] = useState(false),
    [demoUnit, setDemoUnit] = useState("체험 A"),
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
          setComplex(`listing:${p.building_name}`);
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
  const saved = () => {
    clearClientReadCache();
    setGeneration((n) => n + 1);
    setManager(false);
    setSourceSelection(undefined);
  };
  return (
    <div className="structures">
      <div className="structure-intro">
        <div>
          <span className="structure-eyebrow">관리 아파트 도면·구조</span>
          <h2>집의 구조와 기록을 한곳에서</h2>
          <p>
            도면을 살펴보거나 매물·세대 목록에서 기존 업무 기록을 확인하세요.
          </p>
        </div>
        <div className="structure-intro-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              setReference(!reference);
              setDemo(false);
              setManager(false);
            }}
          >
            <FileCheck2 size={17} />
            {reference ? "매물·세대 목록" : "참고 도면 예제"}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setDemo(!demo);
              setReference(false);
              setManager(false);
            }}
          >
            <Box size={17} />
            {demo ? "실제 매물로 돌아가기" : "가상 구조 체험"}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setManager(!manager);
              setReference(false);
              setDemo(false);
            }}
          >
            <Settings2 size={17} />
            {manager ? "관리 닫기" : "도면·연결 관리"}
          </button>
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
          <button type="button" onClick={() => setGeneration((n) => n + 1)}>
            다시 불러오기
          </button>
        </p>
      )}
      <p className="structure-coverage">
        관리 목록 {catalog.managedBuildings?.length ?? 0}곳 · 수집 타입{" "}
        {APARTMENT_SOURCES.reduce((n, s) => n + s.types.length, 0)}개 · 평면도
        원본{" "}
        {APARTMENT_SOURCES.reduce(
          (n, s) => n + s.types.filter((t) => t.basicImage).length,
          0,
        )}
        개 · 장부 세대 연결 {catalog.links.length}/{catalog.properties.length}
      </p>
      {manager ? (
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
      ) : reference ? (
        <RealPlanPreview />
      ) : demo ? (
        <>
          <div className="structure-notice">
            <strong>가상 구조 체험 · 실매물과 무관한 예시</strong>
            <p>
              화면과 조작을 확인하는 가상 도면입니다. 실제 아파트의
              구조·치수·호수가 아닙니다.
            </p>
          </div>
          <div className="structure-demo-bar">
            <span>
              가상 단지 <ChevronRight size={14} /> 체험동
            </span>
            <div className="structure-segment">
              {["체험 A", "체험 B (반전)"].map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={demoUnit === n}
                  onClick={() => setDemoUnit(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <PlanViewer
            key={demoUnit}
            plan={DEMO_PLAN}
            transform={{ mirror: demoUnit !== "체험 A", rotation: 0 }}
          />
        </>
      ) : (
        <div className="structure-layout">
          <aside className="structure-picker">
            <h3>
              <Building2 size={18} /> 단지 선택
            </h3>
            <label className="structure-search">
              <Search size={17} />
              <input
                aria-label="단지 검색"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="단지 이름 검색"
              />
            </label>
            {loading ? (
              <p role="status">단지 목록을 불러오는 중…</p>
            ) : (
              <div className="structure-complex-list">
                {groups
                  .filter((g) =>
                    `${g.name} ${g.address}`.includes(search.trim()),
                  )
                  .map((group) => {
                    const rows = group.properties;
                    const mapped = rows.some((p) =>
                      catalog.links.some(
                        (l) => l.identity_key === p.identity_key,
                      ),
                    );
                    return (
                      <button
                        type="button"
                        key={group.key}
                        aria-pressed={complex === group.key}
                        onClick={() => {
                          setComplex(group.key);
                          setDong("");
                          setKey("");
                        }}
                      >
                        <strong>{group.name}</strong>
                        <small>{group.address}</small>
                        <span>
                          진행 중 {rows.reduce((n, p) => n + p.active_count, 0)}{" "}
                          · 전체 {rows.reduce((n, p) => n + p.listing_count, 0)}
                        </span>
                        <small>
                          {mapped || group.units.some((u) => u.revision_id)
                            ? "연결된 구조 있음"
                            : catalog.revisions.some(
                                  (r) =>
                                    group.key === `complex:${r.complex_id}`,
                                )
                              ? "도면 등록됨 · 세대 연결 필요"
                              : apartmentSources(group.name).some(
                                    (s) => s.types.length,
                                  )
                                ? `공개 타입 ${apartmentSources(group.name).reduce((n, s) => n + s.types.length, 0)}개 · 세대 연결 전`
                                : "도면 원본 수집 대기"}
                        </small>
                      </button>
                    );
                  })}
                {!groups.length && (
                  <p className="structure-help">
                    등록된 아파트 업무가 없습니다. 가상 구조를 체험하거나 확인된
                    도면을 등록할 수 있습니다.
                  </p>
                )}
              </div>
            )}
          </aside>
          <div className="structure-main">
            {!complex ? (
              <div className="structure-welcome">
                <Layers3 size={42} />
                <h3>어떤 집을 살펴볼까요?</h3>
                <p>
                  왼쪽에서 단지를 선택하세요.
                  <br />
                  도면이 없어도 기존 매물·업무 기록을 확인할 수 있습니다.
                </p>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setDemo(true)}
                >
                  가상 구조 먼저 체험하기
                </button>
              </div>
            ) : (
              <>
                <ApartmentSourcePanel
                  key={`${complex}-${key}`}
                  name={selectedGroup?.name ?? ""}
                  sizes={property?.size_types}
                  dong={property?.building_dong}
                  onRegister={(s) => {
                    setSourceSelection(s);
                    setManager(true);
                  }}
                />
                <div className="structure-breadcrumb">
                  <Building2 size={17} />
                  <strong>{selectedGroup?.name ?? "단지 확인 필요"}</strong>
                  {dong && (
                    <>
                      <ChevronRight size={16} />
                      <span>{dong}</span>
                    </>
                  )}
                  {(property || unit) && (
                    <>
                      <ChevronRight size={16} />
                      <span>{property?.unit_number ?? unit?.number}</span>
                    </>
                  )}
                </div>
                <div className="structure-dongs" aria-label="동 선택">
                  {dongs.map((d) => (
                    <button
                      type="button"
                      key={d}
                      aria-pressed={dong === d}
                      onClick={() => {
                        setDong(d);
                        setKey("");
                      }}
                    >
                      {d || "동 미기입"}
                      <small>
                        {properties.filter((p) => p.building_dong === d).length}
                        개 기록 물건
                      </small>
                    </button>
                  ))}
                </div>
                {!dong && !dongs.includes("") ? (
                  <p className="structure-empty">
                    동을 선택해 주세요. 확인된 배치도가 없어 목록으로
                    표시합니다.
                  </p>
                ) : (
                  <>
                    <p className="structure-help">
                      장부에 기록된 물건과 확인된 세대만 표시합니다. 호수로 층을
                      추정하지 않습니다.
                    </p>
                    <div className="structure-units" aria-label="세대 선택">
                      {selectedProperties.map((p) => (
                        <button
                          type="button"
                          key={p.identity_key}
                          aria-pressed={key === p.identity_key}
                          onClick={() => setKey(p.identity_key)}
                        >
                          <strong>{p.unit_number || "호수 미기입"}</strong>
                          <small>
                            {p.size_types
                              ? `장부 평형 ${p.size_types}`
                              : "평형 미기입"}
                          </small>
                          <span>
                            {catalog.links.some(
                              (l) => l.identity_key === p.identity_key,
                            )
                              ? "구조 연결됨"
                              : p.listing_count
                                ? "매물 기록"
                                : "업무 기록"}
                          </span>
                        </button>
                      ))}
                      {selectedUnits.map((u) => (
                        <button
                          type="button"
                          key={u.id}
                          aria-pressed={key === `unit:${u.id}`}
                          onClick={() => setKey(`unit:${u.id}`)}
                        >
                          <strong>{u.number}</strong>
                          <span>
                            {u.floor === null ? "층 미확인" : `${u.floor}층`} ·
                            확인된 세대
                          </span>
                        </button>
                      ))}
                    </div>
                    {key ? (
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
                      <p className="structure-empty">
                        호수를 선택하면 구조와 업무 기록이 이곳에 표시됩니다.
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </div>
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
    [tab, setTab] = useState("plan"),
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
      <div className="structure-mobile-tabs structure-segment">
        <button
          type="button"
          aria-pressed={tab === "plan"}
          onClick={() => setTab("plan")}
        >
          구조
        </button>
        <button
          type="button"
          aria-pressed={tab === "records"}
          onClick={() => setTab("records")}
        >
          매물·이력 ({records.length})
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
          <button type="button" onClick={retry}>
            다시 불러오기
          </button>
        </p>
      )}
      <div className="structure-detail" data-tab={tab}>
        <section className="structure-plan-panel">
          {loading ? (
            <p className="structure-empty" role="status">
              세대 자료를 불러오는 중…
            </p>
          ) : revision ? (
            <>
              <div className="structure-plan-heading">
                <FileCheck2 size={18} />
                <strong>
                  {revision.revision.type_name} · v{revision.revision.version}
                </strong>
                <span>
                  {revision.revision.variant === "base"
                    ? "기본형"
                    : revision.revision.variant === "expanded"
                      ? "확장형"
                      : "리모델링"}
                </span>
              </div>
              <p className="structure-notice">
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
              {revision.file ? (
                <Suspense
                  fallback={<p role="status">도면을 준비하고 있습니다…</p>}
                >
                  <PlanWorkbench
                    key={revision.file.revision_id}
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
          {revision && (
            <button
              type="button"
              className="secondary-button"
              onClick={onManage}
            >
              도면 연결 관리
            </button>
          )}
        </section>
        <aside className="structure-record-panel">
          <h3>매물·업무 기록</h3>
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
        </aside>
      </div>
    </>
  );
}
