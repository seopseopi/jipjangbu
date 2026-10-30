"use client";
import { useState } from "react";
import {
  apartmentSources,
  sourceTypeCandidates,
  type ApartmentSource,
  type SourceType,
} from "./source-contract";
import { PlanViewer } from "./plan-viewer";
import { HILLSTATE_109_REFERENCE } from "./hillstate-reference";
import { FileViewer } from "./file-viewer";
export type SourceSelection = {
  source: ApartmentSource;
  type: SourceType;
  variant: "base" | "expanded";
};
export function ApartmentSourcePanel({
  name,
  sizes = "",
  dong = "",
  onRegister,
}: {
  name: string;
  sizes?: string;
  dong?: string;
  onRegister: (s: SourceSelection) => void;
}) {
  const sources = apartmentSources(name),
    [selected, setSelected] = useState(""),
    [variant, setVariant] = useState<"base" | "expanded">("base"),
    [showModel, setShowModel] = useState(false);
  const source = sources[0],
    candidates = source ? sourceTypeCandidates(source, sizes, dong) : [],
    type =
      source?.types.find((t) => t.id === selected) ??
      (sizes ? candidates[0] : source?.types[0]);
  if (!source)
    return (
      <p className="structure-notice">
        이 장부명에 대응하는 공식 단지와 도면 출처를 확인 중입니다.
      </p>
    );
  const image = variant === "base" ? type?.basicImage : type?.expandedImage;
  const referenceModel =
    source.alias === "힐스테이트1차" &&
    type?.exclusiveArea === "84.28" &&
    variant === "base";
  return (
    <section className="structure-source-library">
      <span className="structure-eyebrow">
        수집한 단지·타입 자료 · {source.checkedAt}
      </span>
      <h3>{source.name}</h3>
      <p>{source.address}</p>
      <p className="structure-notice">{source.note}</p>
      <a href={source.sourceUrl} target="_blank" rel="noreferrer">
        단지·평면도 출처 열기 ↗
      </a>
      {sizes && (
        <p className="structure-notice">
          장부 평형 {sizes} ·{" "}
          {candidates.length
            ? `면적 표기로 찾은 후보: ${candidates.map((t) => t.label).join(", ")} (세대 타입 미확정)`
            : "수집 자료와 일치하는 타입 후보가 없습니다. 단지명·평형을 재확인하세요."}
        </p>
      )}
      {sizes && !candidates.length && !selected && source.types.length > 0 && (
        <button type="button" onClick={() => setSelected(source.types[0].id)}>
          전체 타입을 직접 비교
        </button>
      )}
      {type ? (
        <>
          <div className="structure-form-grid">
            <label>
              수집한 타입
              <select
                aria-label="수집한 평면도 타입"
                value={type.id}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setShowModel(false);
                }}
              >
                {source.types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} · 전용 {t.exclusiveArea}㎡
                  </option>
                ))}
              </select>
            </label>
            <label>
              원본 구분
              <select
                value={variant}
                onChange={(e) => {
                  setVariant(e.target.value as "base" | "expanded");
                  setShowModel(false);
                }}
              >
                <option value="base">기본형</option>
                <option value="expanded">확장형</option>
              </select>
            </label>
          </div>
          <p>
            공급 {type.supplyArea}㎡ · 전용 {type.exclusiveArea}㎡ · 방{" "}
            {type.rooms ?? "미확인"} · 욕실 {type.bathrooms ?? "미확인"} · 해당
            타입 {type.households ?? "미확인"}세대
          </p>
          {image ? (
            <>
              <div className="structure-segment">
                <button
                  type="button"
                  aria-pressed={!showModel}
                  onClick={() => setShowModel(false)}
                >
                  수집한 2D 원본
                </button>
                <button
                  type="button"
                  disabled={!referenceModel}
                  aria-pressed={showModel}
                  onClick={() => setShowModel(true)}
                >
                  {referenceModel
                    ? "2D·3D 재구성 (대조 전)"
                    : "3D 구조 제작 대기"}
                </button>
                <button
                  type="button"
                  onClick={() => onRegister({ source, type, variant })}
                >
                  이 도면 가공·등록
                </button>
              </div>
              {showModel && referenceModel ? (
                <PlanViewer plan={HILLSTATE_109_REFERENCE} />
              ) : (
                <FileViewer
                  key={`${type.id}-${variant}`}
                  file={{
                    file_name: `${source.name}-${type.label}-${variant}.jpg`,
                    mime_type: "image/jpeg",
                  }}
                  url={`/api/structures/source-image?alias=${encodeURIComponent(source.alias)}&type=${encodeURIComponent(type.id)}&variant=${variant}`}
                />
              )}
            </>
          ) : (
            <p className="structure-empty">
              이 타입의 {variant === "base" ? "기본형" : "확장형"} 원본은
              제공되지 않았습니다. 다른 타입의 도면으로 대체하지 않습니다.
            </p>
          )}
        </>
      ) : (
        <p className="structure-empty">
          장부와 맞는 타입을 확인하거나 원본 도면을 추가 수집해야 합니다.
        </p>
      )}
      <p className="structure-help">
        단지·타입 자료이며 특정 세대의 타입·방향·확장 상태를 확인한 자료는
        아닙니다.
      </p>
    </section>
  );
}
