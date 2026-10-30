import {
  MAX_PLAN_FILE_BYTES,
  PLAN_FILE_TYPES,
  type PlanFile,
} from "../app/structures/file-contract";

export type StoredPlanFile = PlanFile & { storage_key: string };
export async function planBucket(): Promise<R2Bucket> {
  const { env } = await import("cloudflare:workers");
  if (!env.BACKUPS) throw new Error("도면 파일 저장소를 확인할 수 없습니다.");
  return env.BACKUPS;
}

export function hasFileSignature(bytes: Uint8Array, type: string) {
  if (type === "application/pdf")
    return new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
  if (type === "image/jpeg")
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === "image/png")
    return [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n);
  return false;
}

// Forward bounded chunks instead of buffering a 32MiB PDF inside the Worker.
// R2 verifies SHA-256 before committing the immutable object.
export async function uploadPlanFile(
  request: Request,
  bucket: R2Bucket,
  revisionId: string,
): Promise<StoredPlanFile> {
  const type = request.headers.get("Content-Type")?.split(";")[0] ?? "";
  const size = Number(request.headers.get("X-File-Size"));
  const sha256 = request.headers.get("X-File-SHA256") ?? "";
  let name: string;
  try {
    name = decodeURIComponent(request.headers.get("X-File-Name") ?? "");
  } catch {
    throw new Error("파일 이름을 확인해 주세요.");
  }
  if (!PLAN_FILE_TYPES.includes(type as (typeof PLAN_FILE_TYPES)[number]))
    throw new Error("PDF, JPG, PNG 파일만 등록할 수 있습니다.");
  if (!Number.isSafeInteger(size) || size < 8 || size > MAX_PLAN_FILE_BYTES)
    throw new Error("도면은 32MiB 이하 파일을 선택해 주세요.");
  if (!/^[a-f0-9]{64}$/.test(sha256))
    throw new Error("파일 검증 정보를 확인해 주세요.");
  if (
    !name.trim() ||
    name.length > 200 ||
    Array.from(name).some(
      (c) =>
        c.charCodeAt(0) < 32 ||
        c.charCodeAt(0) === 127 ||
        c === "/" ||
        c === "\\",
    )
  )
    throw new Error("파일 이름을 확인해 주세요.");
  if (!request.body) throw new Error("도면 파일이 없습니다.");
  const reader = request.body.getReader();
  const prefix: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < 8) {
      const part = await reader.read();
      if (part.done) throw new Error("도면 파일이 올바르지 않습니다.");
      length += part.value.byteLength;
      if (length > size) throw new Error("파일 크기가 일치하지 않습니다.");
      prefix.push(part.value);
    }
    const signature = new Uint8Array(8);
    let offset = 0;
    for (const part of prefix) {
      const n = Math.min(part.length, 8 - offset);
      signature.set(part.subarray(0, n), offset);
      offset += n;
      if (offset === 8) break;
    }
    if (!hasFileSignature(signature, type))
      throw new Error("확장자와 파일 내용이 일치하지 않습니다.");
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  const pipe =
    typeof FixedLengthStream === "undefined"
      ? new TransformStream<Uint8Array, Uint8Array>()
      : new FixedLengthStream(size);
  const writer = pipe.writable.getWriter();
  const key = `structure-files/${revisionId}/${sha256}`;
  const pump = (async () => {
    try {
      for (const chunk of prefix) await writer.write(chunk);
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > size) throw new Error("파일 크기가 일치하지 않습니다.");
        await writer.write(part.value);
      }
      if (length !== size) throw new Error("파일 크기가 일치하지 않습니다.");
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
      throw error;
    } finally {
      await reader.cancel().catch(() => {});
    }
  })();
  const store = Promise.resolve().then(() =>
    bucket.put(key, pipe.readable, {
      sha256,
      httpMetadata: { contentType: type },
    }),
  );
  try {
    const [object] = await Promise.all([store, pump]);
    if (!object || object.size !== size)
      throw new Error("파일 저장을 확인하지 못했습니다.");
  } catch (error) {
    await reader.cancel().catch(() => {});
    await pipe.readable.cancel(error).catch(() => {});
    await writer.abort(error).catch(() => {});
    await Promise.allSettled([store, pump]);
    await bucket.delete(key).catch(() => {});
    throw error;
  }
  return {
    revision_id: revisionId,
    storage_key: key,
    file_name: name.trim(),
    mime_type: type,
    byte_size: size,
    sha256,
  };
}
