import { getD1 } from "../../../../../db";
import { ready, apiError } from "../../../_shared";
import {
  planBucket,
  type StoredPlanFile,
} from "../../../../../worker/structure-files";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await ready();
    const { id } = await params;
    if (!/^[a-f0-9-]{36}$/.test(id))
      return Response.json(
        { error: "도면 파일을 찾을 수 없습니다." },
        { status: 404 },
      );
    const file = await getD1()
      .prepare("SELECT * FROM structure_plan_files WHERE revision_id=?")
      .bind(id)
      .first<StoredPlanFile>();
    if (!file)
      return Response.json(
        { error: "도면 파일을 찾을 수 없습니다." },
        { status: 404 },
      );
    const object = await (await planBucket()).get(file.storage_key);
    if (!object || object.size !== file.byte_size)
      return Response.json(
        { error: "원본 파일을 불러오지 못했습니다. 다시 시도해 주세요." },
        { status: 503 },
      );
    return new Response(object.body, {
      headers: {
        "Content-Type": file.mime_type,
        "Content-Length": String(file.byte_size),
        "Content-Disposition": `${new URL(request.url).searchParams.has("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiError(error, "도면 파일을 불러오지 못했습니다.");
  }
}
