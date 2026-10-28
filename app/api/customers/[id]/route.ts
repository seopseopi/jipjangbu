import { getD1 } from "../../../../db";
import { apiError, badRequest, ready } from "../../_shared";
import { DeletionError, moveToTrash, readDeletionRevision } from "../../../../db/deletion-store";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ready();
    const { id } = await params;
    const body = await request.json() as { name?: string; notes?: string; expected?: { name?: unknown; notes?: unknown; created_at?: unknown; updated_at?: unknown; is_demo?: unknown } };
    const name = body.name?.trim();
    if (!name) return badRequest("고객명을 입력해 주세요.");
    const expected = body.expected;
    if (!expected || typeof expected.name !== "string" || typeof expected.notes !== "string"
      || typeof expected.created_at !== "string" || typeof expected.updated_at !== "string" || typeof expected.is_demo !== "number") {
      return badRequest("수정할 고객을 다시 열어 최신 정보를 확인해 주세요.");
    }
    const result = await getD1().prepare(`UPDATE customers SET name = ?, notes = ?, is_demo = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND name = ? AND notes = ? AND created_at = ? AND updated_at = ? AND is_demo = ?`)
      .bind(name, body.notes?.trim() ?? "", decodeURIComponent(id), expected.name, expected.notes, expected.created_at, expected.updated_at, expected.is_demo).run();
    if (!result.meta.changes) return Response.json({ error: "다른 기기에서 고객 정보가 변경되었거나 삭제되었습니다. 작성 내용을 복사한 뒤 최신 정보를 다시 확인해 주세요." }, { status: 409 });
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error, "고객 정보를 수정하지 못했습니다.");
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ready();
    const { id } = await params;
    const customerId = decodeURIComponent(id);
    return Response.json(await moveToTrash(getD1(), "customer", customerId, await readDeletionRevision(request)));
  } catch (error) {
    if (error instanceof DeletionError) return Response.json({ error: error.message }, { status: error.status });
    return apiError(error, "고객을 삭제하지 못했습니다.");
  }
}
