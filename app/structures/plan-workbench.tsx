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
  const [mode, setMode] = useState(data.processing ? "processed" : "original"),
    [editing, setEditing] = useState(false),
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
    return plan ? <PlanViewer plan={plan} transform={transform} /> : null;
  return (
    <section>
      <div className="structure-segment">
        <button
          type="button"
          aria-pressed={mode === "original"}
          onClick={() => setMode("original")}
        >
          원본 자료
        </button>
        <button
          type="button"
          disabled={!processed}
          aria-pressed={mode === "processed"}
          onClick={() => setMode("processed")}
        >
          분리한 평면도
        </button>
        <button
          type="button"
          disabled={!plan}
          aria-pressed={mode === "model"}
          onClick={() => setMode("model")}
        >
          2D·3D 구조
        </button>
        <button type="button" onClick={() => setEditing((v) => !v)}>
          {editing ? "편집 닫기" : "평면도 가공·구조 편집"}
        </button>
      </div>
      {editing && (
        <PlanEditor
          key={processed?.rowVersion ?? 0}
          data={current}
          onSaved={(next) => {
            setCurrent(next);
            setEditing(false);
            setMode("processed");
          }}
        />
      )}
      {mode === "original" && (
        <FileViewer
          file={current.file}
          url={`/api/structures/files/${current.revision.id}`}
        />
      )}
      {mode === "processed" &&
        (imageError ? (
          <p role="alert">{imageError}</p>
        ) : image ? (
          <FileViewer
            file={{
              file_name: `${current.revision.type_name} · 분리한 평면도.png`,
              mime_type: "image/png",
            }}
            url={image}
          />
        ) : (
          <p role="status">평면도 영역을 준비하는 중…</p>
        ))}
      {mode === "model" && plan && (
        <PlanViewer plan={plan} transform={transform} />
      )}
      {processed && (
        <p className="structure-help">
          {processed.page}쪽 · 가공 근거: {processed.note} · v
          {processed.rowVersion}
        </p>
      )}
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
    [note, setNote] = useState(data.processing?.note ?? ""),
    [confirmed, setConfirmed] = useState(false),
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
  function invalidate() {
    setConfirmed(false);
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
          confirmed,
          processing: { page, crop, plan, note },
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
        1. 평면도 영역을 드래그 → 2. 외곽과 방의 꼭짓점 선택 → 3. 구조 생성·원본
        대조 후 저장
      </p>
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
                invalidate();
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
              invalidate();
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
              invalidate();
            }}
          />
        </label>
      </div>
      <div className="structure-segment">
        <button
          type="button"
          onClick={() => {
            setStage("crop");
            setPoints([]);
          }}
        >
          영역 자르기
        </button>
        <button
          type="button"
          onClick={() => {
            setStage("outline");
            setPoints([]);
          }}
        >
          외곽 추적
        </button>
        <button
          type="button"
          disabled={!outline.length}
          onClick={() => {
            setStage("room");
            setPoints([]);
          }}
        >
          방 추적
        </button>
        <button type="button" onClick={() => setPoints((p) => p.slice(0, -1))}>
          점 취소
        </button>
      </div>
      {stage === "crop" && (
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
                  invalidate();
                }}
              />
            </label>
          ))}
        </div>
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
                invalidate();
              }
            } else if (stage !== "crop") {
              const point = locate(e);
              setPoints((p) => [...p, point]);
              invalidate();
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
              invalidate();
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
                invalidate();
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
                invalidate();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            추적한 구조로 2D·3D 생성
          </button>
        </>
      )}
      {plan && (
        <>
          <PlanViewer plan={plan} />
          <button
            type="button"
            onClick={() => {
              setPlan(null);
              invalidate();
            }}
          >
            구조 제거 · 자른 평면도만 저장
          </button>
        </>
      )}
      <p className="structure-help">
        치수·층고는 배치 시각화용입니다. 문·창문은 자동 추정하지 않습니다.
        방·벽이 변경되면 구조를 다시 생성하세요.
      </p>
      <label>
        가공 근거
        <textarea
          maxLength={2000}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            invalidate();
          }}
          placeholder="예: 7쪽 74A 기본형에서 평면도 영역을 분리, 방 경계 대조"
        />
      </label>
      <label className="structure-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        평면도 영역·타입·생성한 구조를 원본과 대조했습니다.
      </label>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        disabled={
          busy || !confirmed || !note.trim() || !url || loadedKey !== imageKey
        }
        onClick={save}
      >
        {busy ? "저장 중…" : "가공 결과 저장"}
      </button>
    </div>
  );
}
