import { getD1 } from "../../../db";
import { ready, apiError } from "../_shared";
import {
  planBucket,
  uploadPlanFile,
  type StoredPlanFile,
} from "../../../worker/structure-files";
import { validateProcessing } from "../../structures/processing";
import { validatePlan } from "../../structures/plan";

export async function GET(request: Request) {
  try {
    await ready();
    const db = getD1(),
      id = new URL(request.url).searchParams.get("revision");
    if (id) {
      const row = await db
        .prepare(
          `SELECT r.*,t.name AS type_name,t.complex_id FROM structure_plan_revisions r JOIN structure_plan_types t ON t.id=r.type_id WHERE r.id=?`,
        )
        .bind(id)
        .first<{ geometry_json: string; [key: string]: unknown }>();
      if (!row)
        return Response.json(
          { error: "도면을 찾을 수 없습니다." },
          { status: 404 },
        );
      const { geometry_json, ...revision } = row;
      const file = await db
        .prepare(
          "SELECT revision_id,file_name,mime_type,byte_size,sha256 FROM structure_plan_files WHERE revision_id=?",
        )
        .bind(id)
        .first();
      const processed = await db
        .prepare(
          "SELECT processing_json,row_version FROM structure_plan_processing WHERE revision_id=?",
        )
        .bind(id)
        .first<{ processing_json: string; row_version: number }>();
      return Response.json({
        revision,
        plan: JSON.parse(geometry_json),
        file,
        processing: processed
          ? {
              ...JSON.parse(processed.processing_json),
              rowVersion: processed.row_version,
            }
          : null,
      });
    }
    const results = await db.batch([
      db.prepare(`WITH properties AS (
        SELECT identity_key,building_name,building_dong,unit_number,size_type FROM listings WHERE property_type='아파트'
        UNION SELECT lower(trim(property_type)||'|'||trim(building_name)||'|'||trim(building_dong)||'|'||trim(unit_number)),building_name,building_dong,unit_number,size_type FROM work_log_properties WHERE property_type='아파트' AND trim(building_name)<>'' AND trim(unit_number)<>''
      ) SELECT p.identity_key,p.building_name,p.building_dong,p.unit_number,group_concat(DISTINCT p.size_type) AS size_types,CASE WHEN l.id IS NULL THEN 0 ELSE 1 END AS listing_count,CASE WHEN l.id IS NOT NULL AND l.closed_at IS NULL THEN 1 ELSE 0 END AS active_count FROM properties p LEFT JOIN listings l ON l.identity_key=p.identity_key GROUP BY p.identity_key,p.building_name,p.building_dong,p.unit_number ORDER BY p.building_name,p.building_dong,p.unit_number`),
      db.prepare("SELECT * FROM structure_complexes ORDER BY name,id"),
      db.prepare(
        `SELECT u.*,b.name AS building_name,b.complex_id,c.name AS complex_name,a.revision_id,a.mirror,a.rotation,a.actual_condition,a.row_version FROM structure_units u JOIN structure_buildings b ON b.id=u.building_id JOIN structure_complexes c ON c.id=b.complex_id LEFT JOIN structure_assignments a ON a.unit_id=u.id ORDER BY c.name,b.name,u.floor DESC,u.number`,
      ),
      db.prepare(
        "SELECT r.id,r.type_id,r.version,r.source,r.variant,r.permission_evidence,r.verified_at,t.name AS type_name,t.complex_id FROM structure_plan_revisions r JOIN structure_plan_types t ON t.id=r.type_id ORDER BY t.name,r.version DESC",
      ),
      db.prepare("SELECT identity_key,unit_id FROM structure_listing_links"),
      db.prepare(
        "SELECT id,building_name FROM property_buildings WHERE property_type='아파트' ORDER BY sort_order,id",
      ),
    ]);
    return Response.json({
      properties: results[0].results,
      complexes: results[1].results,
      units: results[2].results,
      revisions: results[3].results,
      links: results[4].results,
      managedBuildings: results[5].results,
    });
  } catch (error) {
    return apiError(error, "구조 목록을 불러오지 못했습니다.");
  }
}
function required(value: unknown, name: string, max = 300) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new Error(`${name}을(를) 확인해 주세요.`);
  return value.trim();
}
export async function POST(request: Request) {
  try {
    const fileUpload = ["application/pdf", "image/jpeg", "image/png"].includes(
      request.headers.get("Content-Type")?.split(";")[0] ?? "",
    );
    let input;
    if (fileUpload) {
      const metadata = request.headers.get("X-Structure-Metadata") ?? "";
      if (metadata.length > 24000)
        throw new Error("도면 등록 정보를 확인해 주세요.");
      input = JSON.parse(decodeURIComponent(metadata));
    } else {
      if (Number(request.headers.get("content-length") ?? 0) > 600_000)
        return Response.json(
          { error: "파일 크기가 너무 큽니다." },
          { status: 413 },
        );
      const raw = await request.text();
      if (raw.length > 600_000)
        return Response.json(
          { error: "파일 크기가 너무 큽니다." },
          { status: 413 },
        );
      input = JSON.parse(raw);
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("도면 등록 정보를 확인해 주세요.");
    if (fileUpload && input.action !== "revision")
      throw new Error("도면 등록 정보를 확인해 주세요.");
    await ready();
    const db = getD1();
    if (input.action === "process") {
      const revisionId = required(input.revisionId, "도면 버전");
      if (input.confirmed !== true)
        throw new Error("가공 내용과 원본을 대조해 주세요.");
      const processing = validateProcessing(input.processing);
      const exists = await db
        .prepare(
          "SELECT revision_id,mime_type FROM structure_plan_files WHERE revision_id=?",
        )
        .bind(revisionId)
        .first<{ mime_type: string }>();
      if (!exists) throw new Error("원본 파일이 있는 도면을 선택해 주세요.");
      if (exists.mime_type !== "application/pdf" && processing.page !== 1)
        throw new Error("이미지 페이지는 1입니다.");
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0)
        throw new Error("가공 버전을 확인해 주세요.");
      const current = await db
        .prepare(
          "SELECT row_version FROM structure_plan_processing WHERE revision_id=?",
        )
        .bind(revisionId)
        .first<{ row_version: number }>();
      if ((current?.row_version ?? 0) !== input.expectedVersion)
        return Response.json(
          { error: "가공 정보가 변경됐습니다. 다시 불러와 주세요." },
          { status: 409 },
        );
      const statements = [];
      if (current)
        statements.push(
          db
            .prepare(
              "INSERT INTO structure_plan_processing(revision_id,processing_json) SELECT revision_id,processing_json FROM structure_plan_processing WHERE revision_id=? AND row_version<>?",
            )
            .bind(revisionId, input.expectedVersion),
        );
      statements.push(
        current
          ? db
              .prepare(
                "UPDATE structure_plan_processing SET processing_json=?,row_version=row_version+1,updated_at=CURRENT_TIMESTAMP WHERE revision_id=?",
              )
              .bind(JSON.stringify(processing), revisionId)
          : db
              .prepare(
                "INSERT INTO structure_plan_processing(revision_id,processing_json) VALUES(?,?)",
              )
              .bind(revisionId, JSON.stringify(processing)),
      );
      statements.push(
        db
          .prepare(
            "INSERT INTO structure_audit(id,entity_id,action,details) VALUES(?,?,?,?)",
          )
          .bind(
            crypto.randomUUID(),
            revisionId,
            "processing.saved",
            JSON.stringify({
              version: input.expectedVersion + 1,
              note: processing.note,
            }),
          ),
      );
      await db.batch(statements);
      return Response.json({ rowVersion: input.expectedVersion + 1 });
    }
    if (input.action === "revision") {
      const plan = fileUpload ? null : validatePlan(input.plan);
      if (plan?.isDemo || plan?.referenceOnly)
        throw new Error(
          "가상 또는 검증 전 참고 도면은 실세대용 도면으로 등록할 수 없습니다.",
        );
      const name = required(input.complexName, "공식 단지명"),
        address = required(input.address, "공식 주소"),
        typeName = required(input.typeName, "타입 이름"),
        source = required(input.source, "도면 출처", 2000),
        permission = required(input.permissionEvidence, "사용 허락 근거", 2000);
      if (input.confirmed !== true)
        throw new Error("원본 대조와 이용 허락을 확인해 주세요.");
      if (!["base", "expanded", "remodeled"].includes(input.variant))
        throw new Error("구조 구분을 확인해 주세요.");
      const existing = input.complexId
        ? await db
            .prepare("SELECT * FROM structure_complexes WHERE id=?")
            .bind(required(input.complexId, "단지 ID"))
            .first()
        : null;
      if (input.complexId && !existing)
        throw new Error("선택한 단지가 없습니다.");
      const complexId = existing ? String(existing.id) : crypto.randomUUID();
      const type = await db
        .prepare(
          "SELECT id FROM structure_plan_types WHERE complex_id=? AND name=?",
        )
        .bind(complexId, typeName)
        .first<{ id: string }>();
      const typeId = type?.id ?? crypto.randomUUID(),
        revisionId = crypto.randomUUID(),
        statements = [];
      if (!existing)
        statements.push(
          db
            .prepare(
              "INSERT INTO structure_complexes(id,name,address,evidence) VALUES(?,?,?,?)",
            )
            .bind(complexId, name, address, source),
        );
      if (!type)
        statements.push(
          db
            .prepare(
              "INSERT INTO structure_plan_types(id,complex_id,name) VALUES(?,?,?)",
            )
            .bind(typeId, complexId, typeName),
        );
      statements.push(
        db
          .prepare(
            "INSERT INTO structure_plan_revisions(id,type_id,version,geometry_json,source,permission_evidence,variant) SELECT ?,?,COALESCE(MAX(version),0)+1,?,?,?,? FROM structure_plan_revisions WHERE type_id=?",
          )
          .bind(
            revisionId,
            typeId,
            JSON.stringify(plan),
            source,
            permission,
            input.variant,
            typeId,
          ),
      );
      let file: StoredPlanFile | null = null;
      let bucket: R2Bucket | null = null;
      if (fileUpload) {
        bucket = await planBucket();
        file = await uploadPlanFile(request, bucket, revisionId);
        statements.push(
          db
            .prepare(
              "INSERT INTO structure_plan_files(revision_id,storage_key,file_name,mime_type,byte_size,sha256) VALUES(?,?,?,?,?,?)",
            )
            .bind(
              file.revision_id,
              file.storage_key,
              file.file_name,
              file.mime_type,
              file.byte_size,
              file.sha256,
            ),
        );
      }
      statements.push(
        db
          .prepare(
            "INSERT INTO structure_audit(id,entity_id,action,details) VALUES(?,?,?,?)",
          )
          .bind(
            crypto.randomUUID(),
            revisionId,
            "revision.created",
            JSON.stringify({ complexId, typeId, source }),
          ),
      );
      try {
        await db.batch(statements);
      } catch (error) {
        if (file && bucket)
          await bucket.delete(file.storage_key).catch(() => {});
        throw error;
      }
      return Response.json({ id: revisionId, complexId }, { status: 201 });
    }
    if (input.action === "assign") {
      const revisionId = required(input.revisionId, "도면 버전"),
        dong = required(input.dong, "동"),
        number = required(input.number, "호수"),
        evidence = required(input.evidence, "세대 확인 근거", 2000);
      const revision = await db
        .prepare(
          "SELECT t.complex_id FROM structure_plan_revisions r JOIN structure_plan_types t ON t.id=r.type_id WHERE r.id=?",
        )
        .bind(revisionId)
        .first<{ complex_id: string }>();
      if (!revision) throw new Error("검증된 도면 버전을 선택해 주세요.");
      if (input.confirmed !== true)
        throw new Error("세대와 타입 연결을 확인해 주세요.");
      const floor =
        input.floor === "" || input.floor == null ? null : Number(input.floor);
      if (
        floor !== null &&
        (!Number.isInteger(floor) || floor < -20 || floor > 200)
      )
        throw new Error("층을 확인해 주세요. 미확인이면 비워두세요.");
      const mirror =
        input.mirror === null
          ? null
          : input.mirror === true
            ? 1
            : input.mirror === false
              ? 0
              : undefined;
      const rotation = input.rotation === null ? null : Number(input.rotation);
      if (
        mirror === undefined ||
        (rotation !== null && ![0, 90, 180, 270].includes(rotation))
      )
        throw new Error("방향을 확인해 주세요.");
      if (
        !["unknown", "base", "expanded", "remodeled"].includes(
          input.actualCondition,
        )
      )
        throw new Error("실제 세대 상태를 확인해 주세요.");
      const building = await db
        .prepare(
          "SELECT id FROM structure_buildings WHERE complex_id=? AND name=?",
        )
        .bind(revision.complex_id, dong)
        .first<{ id: string }>();
      const buildingId = building?.id ?? crypto.randomUUID();
      const unit = await db
        .prepare(
          "SELECT id FROM structure_units WHERE building_id=? AND number=?",
        )
        .bind(buildingId, number)
        .first<{ id: string }>();
      const unitId = unit?.id ?? crypto.randomUUID();
      const current = unit
        ? await db
            .prepare(
              "SELECT row_version FROM structure_assignments WHERE unit_id=?",
            )
            .bind(unitId)
            .first<{ row_version: number }>()
        : null;
      if ((current?.row_version ?? 0) !== input.expectedVersion)
        return Response.json(
          { error: "연결 정보가 변경됐습니다. 새로 불러온 뒤 확인해 주세요." },
          { status: 409 },
        );
      const key = input.identityKey
        ? required(input.identityKey, "매물 식별키", 1000)
        : null;
      if (key) {
        const found = await db
          .prepare(
            "SELECT identity_key FROM listings WHERE identity_key=? UNION SELECT lower(trim(property_type)||'|'||trim(building_name)||'|'||trim(building_dong)||'|'||trim(unit_number)) FROM work_log_properties WHERE lower(trim(property_type)||'|'||trim(building_name)||'|'||trim(building_dong)||'|'||trim(unit_number))=? LIMIT 1",
          )
          .bind(key, key)
          .first();
        if (!found) throw new Error("기존 업무에 없는 매물입니다.");
        const link = await db
          .prepare(
            "SELECT unit_id FROM structure_listing_links WHERE identity_key=?",
          )
          .bind(key)
          .first<{ unit_id: string }>();
        if (link && link.unit_id !== unitId)
          return Response.json(
            {
              error:
                "이 매물은 다른 세대와 연결되어 있습니다. 기존 연결을 먼저 확인해 주세요.",
            },
            { status: 409 },
          );
      }
      const statements = [];
      if (!building)
        statements.push(
          db
            .prepare(
              "INSERT INTO structure_buildings(id,complex_id,name) VALUES(?,?,?)",
            )
            .bind(buildingId, revision.complex_id, dong),
        );
      if (!unit)
        statements.push(
          db
            .prepare(
              "INSERT INTO structure_units(id,building_id,number,floor,evidence) VALUES(?,?,?,?,?)",
            )
            .bind(unitId, buildingId, number, floor, evidence),
        );
      else
        statements.push(
          db
            .prepare("UPDATE structure_units SET floor=?,evidence=? WHERE id=?")
            .bind(floor, evidence, unitId),
        );
      // Atomic optimistic lock: duplicate-PK conflict aborts the entire batch on stale writes.
      if (current)
        statements.push(
          db
            .prepare(
              "INSERT INTO structure_assignments(unit_id,revision_id,mirror,rotation,actual_condition,evidence,row_version) SELECT unit_id,revision_id,mirror,rotation,actual_condition,evidence,row_version FROM structure_assignments WHERE unit_id=? AND row_version<>?",
            )
            .bind(unitId, input.expectedVersion),
        );
      if (current)
        statements.push(
          db
            .prepare(
              "UPDATE structure_assignments SET revision_id=?,mirror=?,rotation=?,actual_condition=?,evidence=?,row_version=row_version+1,updated_at=CURRENT_TIMESTAMP WHERE unit_id=?",
            )
            .bind(
              revisionId,
              mirror,
              rotation,
              input.actualCondition,
              evidence,
              unitId,
            ),
        );
      else
        statements.push(
          db
            .prepare(
              "INSERT INTO structure_assignments(unit_id,revision_id,mirror,rotation,actual_condition,evidence) VALUES(?,?,?,?,?,?)",
            )
            .bind(
              unitId,
              revisionId,
              mirror,
              rotation,
              input.actualCondition,
              evidence,
            ),
        );
      if (key)
        statements.push(
          db
            .prepare(
              "INSERT INTO structure_listing_links(identity_key,unit_id,evidence) VALUES(?,?,?) ON CONFLICT(identity_key) DO UPDATE SET unit_id=CASE WHEN structure_listing_links.unit_id=excluded.unit_id THEN excluded.unit_id ELSE NULL END",
            )
            .bind(key, unitId, evidence),
        );
      statements.push(
        db
          .prepare(
            "INSERT INTO structure_audit(id,entity_id,action,details) VALUES(?,?,?,?)",
          )
          .bind(
            crypto.randomUUID(),
            unitId,
            "assignment.saved",
            JSON.stringify({ before: current, revisionId, evidence, key }),
          ),
      );
      await db.batch(statements);
      return Response.json({ id: unitId }, { status: 201 });
    }
    return Response.json(
      { error: "지원하지 않는 작업입니다." },
      { status: 400 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "입력을 확인해 주세요.";
    if (/constraint|UNIQUE/i.test(message))
      return Response.json(
        { error: "다른 작업과 충돌했습니다. 새로고침 후 다시 확인해 주세요." },
        { status: 409 },
      );
    return Response.json({ error: message }, { status: 422 });
  }
}
