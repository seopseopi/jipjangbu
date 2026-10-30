import { sourceImageUrl } from "../../../structures/source-contract";
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams,
    url = sourceImageUrl(
      p.get("alias") ?? "",
      p.get("type") ?? "",
      p.get("variant") ?? "base",
    );
  if (!url)
    return Response.json(
      { error: "확인된 원본 주소가 없습니다." },
      { status: 404 },
    );
  try {
    const upstream = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    const mime = upstream.headers.get("content-type")?.split(";")[0];
    if (!upstream.ok || !["image/jpeg", "image/png"].includes(mime ?? ""))
      throw new Error("invalid source");
    if (!upstream.body) throw new Error("empty source");
    const reader = upstream.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 8 * 1024 * 1024) throw new Error("source too large");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of chunks) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
      png =
        bytes[0] === 137 &&
        bytes[1] === 80 &&
        bytes[2] === 78 &&
        bytes[3] === 71;
    if ((mime === "image/jpeg" && !jpeg) || (mime === "image/png" && !png))
      throw new Error("invalid image signature");
    return new Response(bytes, {
      headers: {
        "Content-Type": mime!,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json(
      { error: "외부 원본을 읽지 못했습니다. 출처 페이지에서 확인해 주세요." },
      { status: 502 },
    );
  }
}
