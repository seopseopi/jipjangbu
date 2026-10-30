import type { StoredPlanFile } from "./structure-files";

export function validStoredFile(file: StoredPlanFile) {
  return (
    /^[a-f0-9-]{36}$/.test(file.revision_id) &&
    /^[a-f0-9]{64}$/.test(file.sha256) &&
    file.storage_key === `structure-files/${file.revision_id}/${file.sha256}`
  );
}

// A downloaded JSON backup contains original file bytes. Stored snapshots keep
// immutable object references so normal writes never re-copy all PDFs.
export async function portableBackupStream(
  payload: ArrayBuffer,
  bucket: R2Bucket,
): Promise<ReadableStream<Uint8Array> | ArrayBuffer> {
  const text = new TextDecoder().decode(payload);
  const backup = JSON.parse(text) as {
    tables: { structure_plan_files?: StoredPlanFile[] };
  };
  const files = backup.tables.structure_plan_files ?? [];
  if (!files.length) return payload;
  for (const file of files) {
    if (!validStoredFile(file)) throw new Error("Invalid plan file reference");
    const object = await bucket.head(file.storage_key);
    if (!object || object.size !== file.byte_size)
      throw new Error("A plan file is missing from this backup");
  }
  const encoder = new TextEncoder();
  async function* generate() {
    yield encoder.encode(text.trimEnd().slice(0, -1) + ',"files":[');
    for (const [index, file] of files.entries()) {
      const object = await bucket.get(file.storage_key);
      if (!object || object.size !== file.byte_size)
        throw new Error("A plan file is missing from this backup");
      yield encoder.encode(
        (index ? "," : "") +
          JSON.stringify({
            revision_id: file.revision_id,
            sha256: file.sha256,
          }).slice(0, -1) +
          ',"base64":"',
      );
      const reader = object.body.getReader();
      let carry = new Uint8Array(),
        size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > file.byte_size) throw new Error("Plan file size mismatch");
          const joined = new Uint8Array(carry.length + part.value.length);
          joined.set(carry);
          joined.set(part.value, carry.length);
          const end = joined.length - (joined.length % 3);
          for (let n = 0; n < end; n += 48 * 1024) {
            const chunk = joined.subarray(n, Math.min(n + 48 * 1024, end));
            yield encoder.encode(btoa(String.fromCharCode(...chunk)));
          }
          carry = joined.slice(end);
        }
        if (size !== file.byte_size) throw new Error("Plan file size mismatch");
        if (carry.length)
          yield encoder.encode(btoa(String.fromCharCode(...carry)));
      } finally {
        await reader.cancel().catch(() => {});
      }
      yield encoder.encode('"}');
    }
    yield encoder.encode("]}");
  }
  const iterator = generate();
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}
