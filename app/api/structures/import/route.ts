import { getD1 } from "../../../../db";
import { ready, apiError } from "../../_shared";
import { planBucket } from "../../../../worker/structure-files";
import { importPublicPlans } from "../../../../worker/structure-public-import";
import { GET as sourceImage } from "../source-image/route";

export async function POST() {
  try {
    await ready();
    return Response.json(
      await importPublicPlans(
        getD1(),
        await planBucket(),
        (source, type, variant) =>
          sourceImage(
            new Request(
              `https://internal.invalid/api/structures/source-image?alias=${encodeURIComponent(source.alias)}&type=${encodeURIComponent(type.id)}&variant=${variant}`,
            ),
          ),
      ),
    );
  } catch (error) {
    return apiError(error, "도면 연결을 완료하지 못했습니다.");
  }
}
