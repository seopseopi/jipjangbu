import { getD1 } from "../../../../db";
import { apiError, ready } from "../../_shared";
import { deleteFollowUp, FollowUpError, getFollowUp, readFollowUpBody, updateFollowUp } from "../_store";
import { DeletionError, readDeletionRevision } from "../../../../db/deletion-store";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ready();
    const { id } = await params;
    return Response.json({ item: await getFollowUp(getD1(), id) });
  } catch (error) {
    if (error instanceof FollowUpError) return Response.json({ error: error.message }, { status: error.status });
    return apiError(error, "할 일을 불러오지 못했습니다.");
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ready();
    const { id } = await params;
    const item = await updateFollowUp(getD1(), id, await readFollowUpBody(request));
    return Response.json({ item });
  } catch (error) {
    if (error instanceof FollowUpError) return Response.json({ error: error.message }, { status: error.status });
    return apiError(error, "할 일을 수정하지 못했습니다.");
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ready();
    const { id } = await params;
    return Response.json(await deleteFollowUp(getD1(), id, await readDeletionRevision(request)));
  } catch (error) {
    if (error instanceof FollowUpError || error instanceof DeletionError) return Response.json({ error: error.message }, { status: error.status });
    return apiError(error, "할 일을 삭제하지 못했습니다.");
  }
}
