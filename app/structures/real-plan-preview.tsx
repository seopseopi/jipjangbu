"use client";
import { useState } from "react";
import {
  HILLSTATE_SOURCE,
  HILLSTATE_109_REFERENCE,
} from "./hillstate-reference";
import { PlanViewer } from "./plan-viewer";

export function RealPlanPreview() {
  const [showOriginal, setShowOriginal] = useState(false),
    [failed, setFailed] = useState(false);
  return (
    <section className="structure-real-preview">
      <div className="structure-real-heading">
        <div>
          <span className="structure-eyebrow">실제 공개 평면도 기반</span>
          <h3>
            {HILLSTATE_SOURCE.name} · {HILLSTATE_SOURCE.type}
          </h3>
          <p>침실 3 · 욕실 2 · 드레스룸 · 전후면 발코니</p>
        </div>
        <a
          className="secondary-button"
          href={HILLSTATE_SOURCE.page}
          target="_blank"
          rel="noreferrer"
        >
          KB 원본 페이지 ↗
        </a>
      </div>
      <div className="structure-notice">
        <strong>테스트용입니다.</strong>
      </div>
      <div className="structure-segment structure-reference-tabs">
        <button
          type="button"
          aria-pressed={!showOriginal}
          onClick={() => setShowOriginal(false)}
        >
          2D·3D 재구성
        </button>
        <button
          type="button"
          aria-pressed={showOriginal}
          onClick={() => setShowOriginal(true)}
        >
          실제 원본 도면
        </button>
      </div>
      {showOriginal ? (
        <div className="structure-original">
          <p>
            KB부동산 외부 원본입니다. 표시되는 도면의 표기·워터마크를 그대로
            유지합니다.
          </p>
          {failed ? (
            <p role="alert">
              외부 이미지를 불러오지 못했습니다. 원본 링크에서 확인해 주세요.
            </p>
          ) : (
            <a href={HILLSTATE_SOURCE.image} target="_blank" rel="noreferrer">
              {/* Original hosted by its source; no copied image is committed or rehosted. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={HILLSTATE_SOURCE.image}
                alt="검단힐스테이트 109㎡ 기본형 실제 평면도, KB부동산 출처"
                width={600}
                height={449}
                referrerPolicy="no-referrer"
                onError={() => setFailed(true)}
              />
            </a>
          )}
          <a href={HILLSTATE_SOURCE.image} target="_blank" rel="noreferrer">
            원본 이미지 크게 열기 ↗
          </a>
        </div>
      ) : (
        <PlanViewer plan={HILLSTATE_109_REFERENCE} />
      )}
      <details className="structure-source">
        <summary>재구성 근거와 확인하지 않은 부분</summary>
        <p>{HILLSTATE_109_REFERENCE.dimensionEvidence.note}</p>
        <p>
          기본형 원본의 꺾인 외곽, 침실·욕실·주방·현관·드레스룸·발코니 위치를
          따라 작성했습니다. 위생기구·주방 설비의 위치와 바닥 색은 원본을
          참고했고, 높이·재질·타일 크기는 시각화 표현입니다. 쿡탑의 연료 방식은
          확인되지 않았습니다.
        </p>
        <p>
          출처 확인: {HILLSTATE_SOURCE.checkedAt} ·{" "}
          {HILLSTATE_SOURCE.permission}
        </p>
        <p>
          테스트 참고 화면이며 검증 도면 DB에는 등록하지 않았습니다. 원본
          저장·공개 재배포 및 실세대 연결은 사용 범위와 자료를 확인한 뒤
          진행해야 합니다.
        </p>
      </details>
    </section>
  );
}
