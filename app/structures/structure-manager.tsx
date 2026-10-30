"use client";
import { useEffect, useState, type FormEvent } from "react";
import { clientJsonFetch } from "../client-api";
import { validatePlan, type Plan } from "./plan";
import type { Catalog, PropertyRow, RevisionData } from "./contracts";
import { FileViewer } from "./file-viewer";
import { MAX_PLAN_FILE_BYTES, PLAN_FILE_TYPES } from "./file-contract";
import { PlanWorkbench } from "./plan-workbench";
import type { SourceSelection } from "./apartment-source-panel";
import { PlanViewer } from "./plan-viewer";

export function StructureManager({
  catalog,
  sourceSelection,
  property,
  unit,
  onSaved,
}: {
  catalog: Catalog;
  sourceSelection?: SourceSelection;
  property?: PropertyRow;
  unit?: Catalog["units"][number];
  onSaved: (focusKey?: string) => void;
}) {
  const [tab, setTab] = useState(sourceSelection ? "revision" : "assign"),
    [processedRevision, setProcessedRevision] = useState<RevisionData | null>(
      null,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(!!sourceSelection),
    [plan, setPlan] = useState<Plan | null>(null),
    [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState(""),
    [registrationComplex, setRegistrationComplex] = useState(
      unit?.complex_id ??
        catalog.complexes.find(
          (c) =>
            c.name === sourceSelection?.source.name &&
            c.address === sourceSelection?.source.address,
        )?.id ??
        "",
    ),
    [revision, setRevision] = useState(
      unit?.revision_id ?? catalog.revisions[0]?.id ?? "",
    );
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  useEffect(() => {
    if (!sourceSelection) return;
    const controller = new AbortController();
    const { source, type, variant } = sourceSelection;
    void fetch(
      `/api/structures/source-image?alias=${encodeURIComponent(source.alias)}&type=${encodeURIComponent(type.id)}&variant=${variant}`,
      { signal: controller.signal },
    )
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            "원본을 가져오지 못했습니다. 출처 페이지를 확인해 주세요.",
          );
        const blob = await r.blob();
        if (controller.signal.aborted) return;
        const imported = new File(
          [blob],
          `${source.name}-${type.label}-${variant}.${blob.type === "image/png" ? "png" : "jpg"}`,
          { type: blob.type },
        );
        setFile(imported);
        setPreview(URL.createObjectURL(imported));
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [sourceSelection]);
  useEffect(() => {
    if (tab !== "process" || !revision) return;
    const controller = new AbortController();
    void clientJsonFetch<RevisionData>(
      `/api/structures?revision=${encodeURIComponent(revision)}`,
      { signal: controller.signal },
    )
      .then(setProcessedRevision)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [tab, revision]);
  const registeredComplex = catalog.complexes.find(
    (c) => c.id === registrationComplex,
  );
  const availableRevisions = catalog.revisions.filter(
    (r) => !unit || r.complex_id === unit.complex_id,
  );
  const chosen = catalog.revisions.find((r) => r.id === revision);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError("");
    try {
      if (tab === "revision") {
        const metadata = {
          ...data,
          action: "revision",
          source:
            sourceSelection?.source.sourceUrl ?? file?.name ?? "구조 JSON",
          plan,
          confirmed: true,
        };
        if (file) {
          const digest = await crypto.subtle.digest(
            "SHA-256",
            await file.arrayBuffer(),
          );
          const sha = Array.from(new Uint8Array(digest), (n) =>
            n.toString(16).padStart(2, "0"),
          ).join("");
          await clientJsonFetch("/api/structures", {
            method: "POST",
            headers: {
              "Content-Type": file.type,
              "X-File-Name": encodeURIComponent(file.name),
              "X-File-Size": String(file.size),
              "X-File-SHA256": sha,
              "X-Structure-Metadata": encodeURIComponent(
                JSON.stringify(metadata),
              ),
            },
            body: file,
          });
        } else
          await clientJsonFetch("/api/structures", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...data,
              action: "revision",
              source: sourceSelection?.source.sourceUrl ?? "구조 JSON",
              plan,
              confirmed: true,
            }),
          });
      } else {
        const unit = catalog.units.find(
          (u) =>
            u.complex_id === chosen?.complex_id &&
            u.building_name === String(data.dong).trim() &&
            u.number === String(data.number).trim(),
        );
        await clientJsonFetch("/api/structures", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...data,
            action: "assign",
            revisionId: revision,
            identityKey: property?.identity_key,
            expectedVersion: unit?.row_version ?? 0,
            mirror: data.mirror === "unknown" ? null : data.mirror === "yes",
            rotation:
              data.rotation === "unknown" ? null : Number(data.rotation),
            confirmed: true,
          }),
        });
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="structure-manager">
      <button
        type="button"
        className="secondary-button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            let linked = 0,
              first = "";
            for (;;) {
              const result = await clientJsonFetch<{
                linked: number;
                remaining: number;
                skipped: number;
                firstIdentityKey: string;
                errors: unknown[];
              }>("/api/structures/import", { method: "POST" });
              linked += result.linked;
              first ||= result.firstIdentityKey;
              if (result.errors.length) {
                setError(
                  `${linked}건 연결. ${result.errors.length}건은 원본·연결 상태를 확인해 주세요. 다시 실행하면 이어서 연결합니다.`,
                );
                break;
              }
              if (!result.remaining || !result.linked) {
                if (linked) onSaved(first);
                else
                  setError(
                    "추가로 연결할 도면이 없습니다. 평형 충돌·타입 구분·원본 누락 자료를 확인해 주세요.",
                  );
                break;
              }
            }
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "전체 매물 연결 중…" : "전체 매물 도면 연결"}
      </button>
      <label>
        작업
        <select
          aria-label="도면 관리 작업"
          value={tab}
          disabled={busy}
          onChange={(e) => {
            setTab(e.target.value);
            setError("");
          }}
        >
          <option value="assign">세대 연결</option>
          <option value="revision">도면 등록</option>
          <option value="process">도면 편집</option>
        </select>
      </label>
      {tab === "process" ? (
        <>
          <label>
            가공할 도면
            <select
              aria-label="가공할 도면"
              value={revision}
              onChange={(e) => {
                setRevision(e.target.value);
                setProcessedRevision(null);
              }}
            >
              {catalog.revisions.map((r) => (
                <option key={r.id} value={r.id}>
                  {catalog.complexes.find((c) => c.id === r.complex_id)?.name} ·{" "}
                  {r.type_name} · v{r.version}
                </option>
              ))}
            </select>
          </label>
          {!catalog.revisions.length ? (
            <p>먼저 원본 도면을 등록하세요.</p>
          ) : processedRevision &&
            processedRevision.revision.id === revision ? (
            <PlanWorkbench key={revision} data={processedRevision} />
          ) : (
            <p role="status">도면을 불러오는 중…</p>
          )}
          {error && <p role="alert">{error}</p>}
        </>
      ) : (
        <form onSubmit={submit} key={tab}>
          <fieldset disabled={busy}>
            {tab === "revision" ? (
              <>
                <label>
                  기존 단지 (새 버전 추가 시 선택)
                  <select
                    name="complexId"
                    value={registrationComplex}
                    onChange={(e) => setRegistrationComplex(e.target.value)}
                  >
                    <option value="">새 단지 등록</option>
                    {catalog.complexes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {c.address}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="structure-form-grid">
                  <label>
                    공식 단지명
                    <input
                      key={`name-${registrationComplex}`}
                      name="complexName"
                      required
                      maxLength={300}
                      defaultValue={
                        registeredComplex?.name ??
                        sourceSelection?.source.name ??
                        ""
                      }
                      readOnly={!!registeredComplex}
                    />
                  </label>
                  <label>
                    공식 주소
                    <input
                      key={`address-${registrationComplex}`}
                      name="address"
                      required
                      maxLength={300}
                      defaultValue={
                        registeredComplex?.address ??
                        sourceSelection?.source.address ??
                        ""
                      }
                      readOnly={!!registeredComplex}
                    />
                  </label>
                  <label>
                    타입 이름
                    <input
                      name="typeName"
                      defaultValue={sourceSelection?.type.label}
                      required
                      placeholder="예: 84A (확인된 타입 코드)"
                    />
                  </label>
                  <label>
                    도면 구분
                    <select
                      name="variant"
                      defaultValue={sourceSelection?.variant}
                    >
                      <option value="base">기본형</option>
                      <option value="expanded">확장형</option>
                      <option value="remodeled">리모델링</option>
                    </select>
                  </label>
                </div>
                <label>
                  도면 파일 (PDF·JPG·PNG 또는 구조 JSON)
                  {sourceSelection && file && (
                    <span>수집한 원본: {file.name}</span>
                  )}
                  <input
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png,.json,application/pdf,image/jpeg,image/png,application/json"
                    required={!file && !plan}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      setPlan(null);
                      setFile(null);
                      setPreview("");
                      setError("");
                      if (!file) return;
                      try {
                        if (
                          PLAN_FILE_TYPES.includes(
                            file.type as (typeof PLAN_FILE_TYPES)[number],
                          )
                        ) {
                          if (file.size < 8 || file.size > MAX_PLAN_FILE_BYTES)
                            throw new Error(
                              "PDF·이미지는 32MiB 이하 파일을 선택해 주세요.",
                            );
                          setFile(file);
                          setPreview(URL.createObjectURL(file));
                          return;
                        }
                        if (!file.name.toLowerCase().endsWith(".json"))
                          throw new Error(
                            "PDF·JPG·PNG 또는 구조 JSON 파일을 선택해 주세요.",
                          );
                        if (file.size > 512 * 1024)
                          throw new Error(
                            "512 KiB 이하 JSON만 등록할 수 있습니다.",
                          );
                        const result = validatePlan(
                          JSON.parse(await file.text()),
                        );
                        if (result.isDemo || result.referenceOnly)
                          throw new Error(
                            "가상 또는 검증 전 참고 도면은 실세대용 도면으로 등록할 수 없습니다.",
                          );
                        setPlan(result);
                      } catch (err) {
                        setError((err as Error).message);
                      }
                    }}
                  />
                </label>
                {plan && <PlanViewer plan={plan} />}
                {file && preview && (
                  <FileViewer
                    key={preview}
                    url={preview}
                    file={{ file_name: file.name, mime_type: file.type }}
                  />
                )}
              </>
            ) : (
              <>
                {!catalog.revisions.length ? (
                  <p className="structure-notice">
                    등록된 도면이 없습니다. 먼저 ‘도면 등록’에서 실제 자료를
                    등록해 주세요.
                  </p>
                ) : (
                  <>
                    {property && (
                      <p className="structure-notice">
                        연결할 장부 물건:{" "}
                        <strong>
                          {property.building_name} {property.building_dong}{" "}
                          {property.unit_number}
                        </strong>
                        <br />
                        공식 단지·동·호수와 같은 세대인지 확인하세요.
                      </p>
                    )}
                    <label>
                      도면
                      <select
                        value={revision}
                        onChange={(e) => setRevision(e.target.value)}
                        required
                      >
                        {availableRevisions.map((r) => (
                          <option key={r.id} value={r.id}>
                            {
                              catalog.complexes.find(
                                (c) => c.id === r.complex_id,
                              )?.name
                            }{" "}
                            · {r.type_name} · v{r.version} ({r.variant})
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="structure-form-grid">
                      <label>
                        동 표시
                        <input
                          name="dong"
                          readOnly={!!property || !!unit}
                          required
                          defaultValue={
                            unit?.building_name ?? property?.building_dong
                          }
                          placeholder="예: 101동"
                        />
                      </label>
                      <label>
                        호수
                        <input
                          name="number"
                          readOnly={!!property || !!unit}
                          required
                          defaultValue={unit?.number ?? property?.unit_number}
                          placeholder="확인된 호수"
                        />
                      </label>
                      <label>
                        확인된 층
                        <input
                          name="floor"
                          type="number"
                          min={-20}
                          max={200}
                          defaultValue={unit?.floor ?? ""}
                          placeholder="미확인이면 비워두세요"
                        />
                      </label>
                      <label>
                        실제 세대 상태
                        <select
                          name="actualCondition"
                          defaultValue={unit?.actual_condition ?? "unknown"}
                        >
                          <option value="unknown">확장·리모델링 미확인</option>
                          <option value="base">기본형 확인</option>
                          <option value="expanded">확장 확인</option>
                          <option value="remodeled">리모델링 확인</option>
                        </select>
                      </label>
                      <label>
                        원본 대비 좌우반전
                        <select
                          name="mirror"
                          defaultValue={
                            unit?.mirror == null
                              ? "unknown"
                              : unit.mirror
                                ? "yes"
                                : "no"
                          }
                        >
                          <option value="unknown">미확인</option>
                          <option value="no">반전 없음 확인</option>
                          <option value="yes">좌우반전 확인</option>
                        </select>
                      </label>
                      <label>
                        원본 대비 회전
                        <select
                          name="rotation"
                          defaultValue={unit?.rotation ?? "unknown"}
                        >
                          <option value="unknown">미확인</option>
                          {[0, 90, 180, 270].map((n) => (
                            <option key={n} value={n}>
                              {n}° 확인
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="primary-button"
              disabled={
                busy ||
                (tab === "revision"
                  ? !plan && !file
                  : !catalog.revisions.length)
              }
            >
              {busy ? "저장 중…" : tab === "revision" ? "등록" : "연결"}
            </button>
          </fieldset>
        </form>
      )}
    </div>
  );
}
