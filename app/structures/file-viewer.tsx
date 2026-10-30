"use client";
/* Original authenticated/blob images must bypass public image optimization. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PlanFile } from "./file-contract";

type ViewerProps = {
  file: Pick<PlanFile, "file_name" | "mime_type">;
  url: string;
  minimal?: boolean;
  fit?: boolean;
};
export function FileViewer(props: ViewerProps) {
  return <FileViewerContent key={props.url} {...props} />;
}
function FileViewerContent({
  file,
  url,
  minimal = false,
  fit = false,
}: ViewerProps) {
  const pdf = file.mime_type === "application/pdf";
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(1),
    [zoom, setZoom] = useState(1),
    [rotation, setRotation] = useState(0),
    [width, setWidth] = useState(600),
    [height, setHeight] = useState(600),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(pdf),
    [retry, setRetry] = useState(0),
    [imageRatio, setImageRatio] = useState(1);
  const frame = useRef<HTMLDivElement>(null),
    canvasHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!frame.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(80, entry.contentRect.width - 16));
      setHeight(Math.max(80, entry.contentRect.height - 16));
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    let task: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
    if (pdf)
      void import("pdfjs-dist")
        .then(async (lib) => {
          if (cancelled) return;
          lib.GlobalWorkerOptions.workerSrc = `/pdfjs/pdf.worker-${lib.version}.mjs`;
          task = lib.getDocument({ url, withCredentials: true });
          const loaded = await task.promise;
          if (cancelled) return;
          if (loaded.numPages > 500) throw new Error("PDF page limit");
          setDoc(loaded);
        })
        .catch(() => {
          if (!cancelled) {
            setError(
              "PDF를 표시하지 못했습니다. 파일을 내려받아 확인하거나 다시 시도해 주세요.",
            );
            setLoading(false);
          }
        });
    return () => {
      cancelled = true;
      void task?.destroy().catch(() => {});
    };
  }, [url, pdf, retry]);
  useEffect(() => {
    if (!doc || !canvasHost.current) return;
    let cancelled = false;
    let render: import("pdfjs-dist").RenderTask | undefined;
    const host = canvasHost.current,
      canvas = document.createElement("canvas");
    host.replaceChildren(canvas);
    void doc
      .getPage(page)
      .then(async (p) => {
        if (cancelled) return;
        setLoading(true);
        setError("");
        const base = p.getViewport({
          scale: 1,
          rotation: (p.rotate + rotation) % 360,
        });
        const scale =
          Math.min(
            width / base.width,
            fit ? height / base.height : Infinity,
            1.6,
          ) * zoom;
        const viewport = p.getViewport({
          scale,
          rotation: (p.rotate + rotation) % 360,
        });
        const dpr = Math.min(
          window.devicePixelRatio || 1,
          1.5,
          Math.sqrt(8_000_000 / (viewport.width * viewport.height)),
        );
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", `${file.file_name} · ${page}쪽`);
        render = p.render({
          canvas,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        });
        await render.promise;
        if (!cancelled) setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setError("이 페이지를 표시하지 못했습니다. 다시 시도해 주세요.");
        }
      });
    return () => {
      cancelled = true;
      render?.cancel();
      canvas.remove();
    };
  }, [doc, page, zoom, rotation, width, height, file.file_name, fit]);
  const imageWidth =
      (fit
        ? rotation % 180
          ? Math.min(height, width / imageRatio)
          : Math.min(width, height / imageRatio)
        : width) * zoom,
    imageHeight = imageWidth * imageRatio;
  const imageTransform =
    rotation === 90
      ? `translate(${imageHeight}px, 0) rotate(90deg)`
      : rotation === 180
        ? `translate(${imageWidth}px, ${imageHeight}px) rotate(180deg)`
        : rotation === 270
          ? `translate(0, ${imageWidth}px) rotate(270deg)`
          : undefined;
  return (
    <section
      className={`structure-file-viewer${fit ? " is-fit" : ""}`}
      aria-label="원본 도면 보기"
    >
      {minimal && pdf && (
        <label>
          페이지{" "}
          <input
            type="number"
            min={1}
            max={doc?.numPages ?? 1}
            value={page}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= 1 && n <= (doc?.numPages ?? 1))
                setPage(n);
            }}
          />{" "}
          / {doc?.numPages ?? "…"}
        </label>
      )}
      {!minimal && (
        <div className="structure-file-toolbar">
          {pdf && (
            <>
              <button
                type="button"
                disabled={!doc || page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                이전 쪽
              </button>
              <label>
                쪽{" "}
                <input
                  aria-label="도면 페이지"
                  type="number"
                  min={1}
                  max={doc?.numPages ?? 1}
                  value={page}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (
                      Number.isInteger(n) &&
                      n >= 1 &&
                      n <= (doc?.numPages ?? 1)
                    )
                      setPage(n);
                  }}
                />{" "}
                / {doc?.numPages ?? "…"}
              </label>
              <button
                type="button"
                disabled={!doc || page >= doc.numPages}
                onClick={() => setPage((p) => p + 1)}
              >
                다음 쪽
              </button>
            </>
          )}
          <button
            type="button"
            disabled={zoom <= 0.5}
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
          >
            축소
          </button>
          <button
            type="button"
            disabled={zoom >= 3}
            onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
          >
            확대
          </button>
          <button
            type="button"
            onClick={() => setRotation((r) => (r + 90) % 360)}
          >
            90° 회전
          </button>
          <button
            type="button"
            onClick={() => {
              setZoom(1);
              setRotation(0);
            }}
          >
            전체 보기
          </button>
          <a
            href={
              url.includes("/api/structures/files/") ? `${url}?download=1` : url
            }
            download={file.file_name}
          >
            원본 내려받기
          </a>
        </div>
      )}
      {loading && <p role="status">도면을 불러오는 중…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            type="button"
            onClick={() => {
              setDoc(null);
              setLoading(pdf);
              setError("");
              setRetry((n) => n + 1);
            }}
          >
            다시 시도
          </button>
        </p>
      )}
      <div ref={frame} className="structure-file-frame">
        {pdf ? (
          <div ref={canvasHost} />
        ) : (
          <div
            style={{
              position: "relative",
              width: rotation % 180 ? imageHeight : imageWidth,
              height: rotation % 180 ? imageWidth : imageHeight,
            }}
          >
            <img
              key={retry}
              src={url}
              alt={file.file_name}
              onLoad={(e) => {
                setError("");
                setImageRatio(
                  e.currentTarget.naturalHeight / e.currentTarget.naturalWidth,
                );
              }}
              onError={() =>
                setError("이미지를 불러오지 못했습니다. 다시 시도해 주세요.")
              }
              style={{
                position: "absolute",
                width: imageWidth,
                height: imageHeight,
                transform: imageTransform,
                transformOrigin: "top left",
              }}
            />
          </div>
        )}{" "}
      </div>
      {!minimal && (
        <p className="structure-help">
          원본 도면입니다. 이 파일만으로 실제 확장 여부·방향·치수를 확정하지
          않습니다.
        </p>
      )}
    </section>
  );
}
