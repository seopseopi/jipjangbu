"use client";
import { useEffect, useRef, useState } from "react";
import { clientJsonFetch, clearClientReadCache } from "../client-api";
import type { RevisionData } from "./contracts";
import { FileViewer } from "./file-viewer";
import { PlanViewer } from "./plan-viewer";
import { FULL_CROP, tracePlan, type Crop } from "./processing";
import { rasterPage } from "./raster";
import type { Plan, Point, Transform } from "./plan";
export function PlanWorkbench({
  data,
  transform,
}: {
  data: RevisionData;
  transform?: Transform;
}) {
  const [editing, setEditing] = useState(false),
    [current, setCurrent] = useState(data);
  const processed = current.processing,
    plan = processed?.plan ?? current.plan;
  const [image, setImage] = useState(""),
    [imageError, setImageError] = useState("");
  useEffect(() => {
    if (!current.file || !processed) return;
    const controller = new AbortController();
    let object = "";
    void rasterPage(
      `/api/structures/files/${current.revision.id}`,
      current.file.mime_type,
      processed.page,
      processed.crop,
      controller.signal,
    )
      .then(
        (c) =>
          new Promise<Blob>((resolve, reject) =>
            c.toBlob(
              (b) => (b ? resolve(b) : reject(new Error("이미지 생성 실패"))),
              "image/png",
            ),
          ),
      )
      .then((b) => {
        if (!controller.signal.aborted) {
          object = URL.createObjectURL(b);
          setImage(object);
          setImageError("");
        }
      })
      .catch((e) => {
        if (e.name !== "AbortError") setImageError(e.message);
      });
    return () => {
      controller.abort();
      if (object) URL.revokeObjectURL(object);
    };
  }, [current.revision.id, current.file, processed]);
  if (!current.file)
    return plan ? (
      <PlanViewer plan={plan} transform={transform} minimal />
    ) : null;
  return (
    <section className="structure-clean-view">
      {!plan && (transform?.mirror || transform?.rotation) ? (
        <p className="structure-empty">
          이 세대의 방향에 맞는 평면도를 연결해 주세요.
        </p>
      ) : plan ? (
        <PlanViewer plan={plan} transform={transform} minimal />
      ) : processed ? (
        imageError ? (
          <p role="alert">{imageError}</p>
        ) : image ? (
          <figure className="structure-clean-image">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt={`${current.revision.type_name} 평면도`} />
          </figure>
        ) : (
          <p role="status">평면도를 불러오는 중…</p>
        )
      ) : (
        <FileViewer
          file={current.file}
          fit
          minimal
          url={`/api/structures/files/${current.revision.id}`}
        />
      )}
      <details className="structure-plan-options">
        <summary>원본·편집</summary>
        <button type="button" onClick={() => setEditing((v) => !v)}>
          {editing ? "편집 닫기" : "편집"}
        </button>
        {image && (
          <a href={image} download={`${current.revision.type_name}-평면도.png`}>
            평면도 저장
          </a>
        )}
        {editing && (
          <PlanEditor
            key={processed?.rowVersion ?? 0}
            data={current}
            onSaved={(next) => {
              setCurrent(next);
              setEditing(false);
            }}
          />
        )}
        {processed && (
          <FileViewer
            file={current.file}
            url={`/api/structures/files/${current.revision.id}`}
          />
        )}
      </details>
    </section>
  );
}

function PlanEditor({
  data,
  onSaved,
}: {
  data: RevisionData;
  onSaved: (data: RevisionData) => void;
}) {
  const [page, setPage] = useState(data.processing?.page ?? 1),
    [crop, setCrop] = useState<Crop>(data.processing?.crop ?? FULL_CROP),
    [stage, setStage] = useState("crop"),
    [url, setUrl] = useState(""),
    [loadedKey, setLoadedKey] = useState(""),
    [ratio, setRatio] = useState(1),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [width, setWidth] = useState(10),
    [height, setHeight] = useState(2.4),
    [outline, setOutline] = useState<Point[]>([]),
    [rooms, setRooms] = useState<{ name: string; polygon: Point[] }[]>([]),
    [points, setPoints] = useState<Point[]>([]),
    [roomName, setRoomName] = useState("거실"),
    [plan, setPlan] = useState<Plan | null>(data.processing?.plan ?? null);
  const drag = useRef<Point | null>(null);
  const imageKey = JSON.stringify([page, stage === "crop" ? FULL_CROP : crop]);
  useEffect(() => {
    const controller = new AbortController();
    let object = "";
    void rasterPage(
      `/api/structures/files/${data.revision.id}`,
      data.file!.mime_type,
      page,
      stage === "crop" ? FULL_CROP : crop,
      controller.signal,
    )
      .then((c) => {
        if (!controller.signal.aborted) setRatio(c.height / c.width);
        return new Promise<Blob>((resolve, reject) =>
          c.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("이미지 생성 실패"))),
            "image/png",
          ),
        );
      })
      .then((b) => {
        if (!controller.signal.aborted) {
          object = URL.createObjectURL(b);
          setUrl(object);
          setLoadedKey(imageKey);
          setError("");
        }
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => {
      controller.abort();
      if (object) URL.revokeObjectURL(object);
    };
  }, [data.revision.id, data.file, page, crop, stage, imageKey]);
  function locate(e: React.PointerEvent<SVGSVGElement>): Point {
    const r = e.currentTarget.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    ];
  }
  async function save() {
    setError("");
    setBusy(true);
    try {
      await clientJsonFetch("/api/structures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "process",
          revisionId: data.revision.id,
          expectedVersion: data.processing?.rowVersion ?? 0,
          confirmed: true,
          processing: { page, crop, plan, note: "" },
        }),
      });
      clearClientReadCache();
      onSaved(
        await clientJsonFetch<RevisionData>(
          `/api/structures?revision=${data.revision.id}`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="structure-editor">
      <h3>원본에서 평면도 분리</h3>
      <p>
        {stage === "crop"
          ? "평면도만 남기도록 영역을 드래그하세요."
          : "꼭짓점을 차례로 누르세요."}
      </p>
      <details>
        <summary>세부 설정</summary>
        <div className="structure-form-grid">
          {data.file!.mime_type === "application/pdf" && (
            <label>
              평면도 페이지
              <input
                type="number"
                min={1}
                max={500}
                value={page}
                disabled={stage !== "crop"}
                onChange={(e) => {
                  setPage(Number(e.target.value));
                  setCrop(FULL_CROP);
                  setPlan(null);
                }}
              />
            </label>
          )}
          <label>
            시각화 기준 폭 (m)
            <input
              type="number"
              min={0.1}
              max={100}
              step={0.1}
              value={width}
              onChange={(e) => {
                setWidth(Number(e.target.value));
                setPlan(null);
              }}
            />
          </label>
          <label>
            시각화 층고 (m)
            <input
              type="number"
              min={1}
              max={5}
              step={0.1}
              value={height}
              onChange={(e) => {
                setHeight(Number(e.target.value));
                setPlan(null);
              }}
            />
          </label>
        </div>
      </details>
      <div className="structure-editor-tools">
        <label>
          편집 단계
          <select
            aria-label="편집 단계"
            value={stage}
            onChange={(e) => {
              setStage(e.target.value);
              setPoints([]);
            }}
          >
            <option value="crop">평면도 자르기</option>
            <option value="outline">외곽 그리기</option>
            <option value="room" disabled={!outline.length}>
              방 그리기
            </option>
          </select>
        </label>
        {stage !== "crop" && (
          <button
            type="button"
            onClick={() => setPoints((p) => p.slice(0, -1))}
          >
            되돌리기
          </button>
        )}
      </div>
      {stage === "crop" && (
        <details>
          <summary>영역 미세 조정</summary>
          <div className="structure-form-grid">
            {(
              [
                ["x", "왼쪽"],
                ["y", "위쪽"],
                ["width", "가로"],
                ["height", "세로"],
              ] as const
            ).map(([field, label]) => (
              <label key={field}>
                평면도 영역 {label} (%)
                <input
                  type="number"
                  min={field === "x" || field === "y" ? 0 : 1}
                  max={100}
                  step={0.1}
                  value={Number((crop[field] * 100).toFixed(1))}
                  onChange={(e) => {
                    const value = Number(e.target.value) / 100;
                    if (!Number.isFinite(value)) return;
                    const next = {
                      ...crop,
                      [field]: Math.max(
                        field === "x" || field === "y" ? 0 : 0.01,
                        Math.min(
                          field === "x" || field === "y" ? 0.99 : 1,
                          value,
                        ),
                      ),
                    };
                    next.width = Math.min(next.width, 1 - next.x);
                    next.height = Math.min(next.height, 1 - next.y);
                    setCrop(next);
                    setOutline([]);
                    setRooms([]);
                    setPlan(null);
                  }}
                />
              </label>
            ))}
          </div>
        </details>
      )}
      {url && loadedKey === imageKey ? (
        <svg
          className="structure-trace"
          viewBox="0 0 1000 1000"
          style={{ aspectRatio: String(1 / ratio), touchAction: "none" }}
          role="img"
          aria-label="평면도 영역과 방 추적 편집기"
          onPointerDown={(e) => {
            if (stage === "crop") {
              drag.current = locate(e);
              e.currentTarget.setPointerCapture(e.pointerId);
            }
          }}
          onPointerUp={(e) => {
            if (stage === "crop" && drag.current) {
              const end = locate(e),
                start = drag.current;
              drag.current = null;
              const c = {
                x: Math.min(start[0], end[0]),
                y: Math.min(start[1], end[1]),
                width: Math.abs(start[0] - end[0]),
                height: Math.abs(start[1] - end[1]),
              };
              if (c.width >= 0.01 && c.height >= 0.01) {
                setCrop(c);
                setOutline([]);
                setRooms([]);
                setPlan(null);
              }
            } else if (stage !== "crop") {
              const point = locate(e);
              setPoints((p) => [...p, point]);
            }
          }}
        >
          <image
            href={url}
            width="1000"
            height="1000"
            preserveAspectRatio="none"
          />
          {stage === "crop" ? (
            <rect
              x={crop.x * 1000}
              y={crop.y * 1000}
              width={crop.width * 1000}
              height={crop.height * 1000}
              fill="#18a09033"
              stroke="#007b70"
              strokeWidth="4"
            />
          ) : (
            <>
              {outline.length > 0 && (
                <polygon
                  points={outline
                    .map((p) => p.map((n) => n * 1000).join(","))
                    .join(" ")}
                  fill="none"
                  stroke="#147b66"
                  strokeWidth="4"
                />
              )}
              {rooms.map((r, i) => (
                <polygon
                  key={i}
                  points={r.polygon
                    .map((p) => p.map((n) => n * 1000).join(","))
                    .join(" ")}
                  fill="#2288cc33"
                  stroke="#2277aa"
                  strokeWidth="3"
                />
              ))}
              <polyline
                points={points
                  .map((p) => p.map((n) => n * 1000).join(","))
                  .join(" ")}
                fill="none"
                stroke="#e45c22"
                strokeWidth="5"
              />
              {points.map((p, i) => (
                <circle
                  key={i}
                  cx={p[0] * 1000}
                  cy={p[1] * 1000}
                  r="7"
                  fill="#e45c22"
                />
              ))}
            </>
          )}
        </svg>
      ) : (
        <p role="status">원본 페이지를 준비하는 중…</p>
      )}
      {stage === "crop" ? (
        <p>광고·면적표를 제외하고 평면도만 드래그하세요. 원본은 보존됩니다.</p>
      ) : (
        <>
          {stage === "room" && (
            <label>
              방 이름
              <input
                maxLength={40}
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
              />
            </label>
          )}
          <button
            type="button"
            disabled={points.length < 3}
            onClick={() => {
              if (stage === "outline") {
                setOutline(points);
                setRooms([]);
                setStage("room");
              } else {
                setRooms((r) => [...r, { name: roomName, polygon: points }]);
              }
              setPoints([]);
              setPlan(null);
            }}
          >
            {stage === "outline" ? "외곽 완료" : "방 추가"} ({points.length}점)
          </button>
          <p>
            외곽 {outline.length}점 · 방 {rooms.length}개
          </p>
          {rooms.map((r, i) => (
            <button
              type="button"
              key={i}
              onClick={() => {
                setRooms((v) => v.filter((_, n) => n !== i));
                setPlan(null);
              }}
            >
              {r.name} 삭제
            </button>
          ))}
          <button
            type="button"
            disabled={!outline.length || !rooms.length}
            onClick={() => {
              try {
                setPlan(tracePlan(outline, rooms, width, ratio, height));
                setError("");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            구조 생성
          </button>
        </>
      )}
      {plan && (
        <>
          <PlanViewer plan={plan} minimal />
          <button
            type="button"
            onClick={() => {
              setPlan(null);
            }}
          >
            구조 삭제
          </button>
        </>
      )}
      <p className="structure-help">
        치수·층고는 배치 시각화용입니다. 문·창문은 자동 추정하지 않습니다.
        방·벽이 변경되면 구조를 다시 생성하세요.
      </p>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        disabled={busy || !url || loadedKey !== imageKey}
        onClick={save}
      >
        {busy ? "저장 중…" : "저장"}
      </button>
    </div>
  );
}
