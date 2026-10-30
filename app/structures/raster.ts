import type { Crop } from "./processing";
export async function rasterPage(
  url: string,
  mime: string,
  page: number,
  crop: Crop,
  signal: AbortSignal,
) {
  const canvas = document.createElement("canvas"),
    ctx = canvas.getContext("2d")!;
  if (mime === "application/pdf") {
    const lib = await import("pdfjs-dist");
    lib.GlobalWorkerOptions.workerSrc = `/pdfjs/pdf.worker-${lib.version}.mjs`;
    const task = lib.getDocument({ url, withCredentials: true });
    const abort = () => {
      void task.destroy().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const doc = await task.promise;
      if (doc.numPages > 500 || page > doc.numPages)
        throw new Error("페이지 범위를 확인해 주세요.");
      const p = await doc.getPage(page),
        base = p.getViewport({ scale: 1 }),
        viewport = p.getViewport({
          scale: Math.min(1800 / base.width, 1800 / base.height, 2.5),
        });
      canvas.width = Math.max(1, Math.round(viewport.width * crop.width));
      canvas.height = Math.max(1, Math.round(viewport.height * crop.height));
      await p.render({
        canvas,
        viewport,
        transform: [
          1,
          0,
          0,
          1,
          -viewport.width * crop.x,
          -viewport.height * crop.y,
        ],
      }).promise;
    } finally {
      signal.removeEventListener("abort", abort);
      await task.destroy().catch(() => {});
    }
  } else {
    const response = await fetch(url, { credentials: "same-origin", signal });
    if (!response.ok) throw new Error("원본을 읽지 못했습니다.");
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const sx = bitmap.width * crop.x,
        sy = bitmap.height * crop.y,
        sw = bitmap.width * crop.width,
        sh = bitmap.height * crop.height,
        scale = Math.min(1, 1800 / sw, 1800 / sh);
      canvas.width = Math.max(1, Math.round(sw * scale));
      canvas.height = Math.max(1, Math.round(sh * scale));
      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    } finally {
      bitmap.close();
    }
  }
  if (signal.aborted) throw new DOMException("취소됨", "AbortError");
  return canvas;
}
