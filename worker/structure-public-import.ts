import prepared from "../app/structures/prepared-plans.json" with { type: "json" };
import {
  APARTMENT_BUILDING_TYPES,
  apartmentSources,
  sourceTypeCandidates,
  type ApartmentSource,
  type SourceType,
} from "../app/structures/source-contract";
import { validateProcessing, type Crop } from "../app/structures/processing";
import { uploadPlanFile } from "./structure-files";

type Listing = {
  identity_key: string;
  building_name: string;
  building_dong: string;
  unit_number: string;
  size_type: string;
};
type PreparedPlan = { typeId: string; sourceImage: string; sha256: string; crop: Crop; plan: unknown };
export function publicPlanCandidate(row: Listing, models: readonly PreparedPlan[] = prepared) {
  const source = apartmentSources(row.building_name)[0];
  if (!source || !/^\d+$/.test(row.unit_number.trim())) return null;
  const dong = row.building_dong.trim().replace(/동$/, "");
  const building = APARTMENT_BUILDING_TYPES.find(
    (c) => c.alias === source.alias && c.sourceUrl === source.sourceUrl,
  )?.buildings.find((b) => b.dong === dong);
  if (!building || building.typeIds.length !== 1) return null;
  const types = sourceTypeCandidates(source, row.size_type, dong);
  if (types.length !== 1 || types[0].id !== building.typeIds[0]) return null;
  const model = models.find(
    (p) => p.typeId === types[0].id && p.sourceImage === types[0].basicImage,
  );
  return model ? { source, type: types[0], building, model, dong } : null;
}

/** Authenticated POST only, protected by the existing pre/post mutation backup.
 * Imports current, non-demo listings with a single published building type and
 * matching journal label. Mixed types, conflicts and existing links are untouched.
 */
export async function importPublicPlans(
  db: D1Database,
  bucket: R2Bucket,
  image: (source: ApartmentSource, type: SourceType) => Promise<Response>,
  models: readonly PreparedPlan[] = prepared,
) {
  const rows = await db.prepare(`SELECT identity_key,building_name,building_dong,unit_number,size_type
    FROM listings WHERE property_type='아파트' AND closed_at IS NULL AND is_demo=0
    AND NOT EXISTS(SELECT 1 FROM structure_listing_links k WHERE k.identity_key=listings.identity_key)
    ORDER BY building_name,building_dong,unit_number`).all<Listing>();
  const result = { linked: 0, registered: 0, skipped: 0, firstIdentityKey: "", errors: [] as { property: string; message: string }[] };
  const revisions = new Map<string, { id: string; complexId: string }>();
  for (const row of rows.results) {
    const candidate = publicPlanCandidate(row, models);
    if (!candidate) { result.skipped++; continue; }
    const { source, type, building, model, dong } = candidate;
    try {
      let revision = revisions.get(type.id);
      if (!revision) {
        const processing = validateProcessing({ page: 1, crop: model.crop, plan: model.plan });
        const existing = await db.prepare(`SELECT r.id,t.complex_id AS complexId FROM structure_plan_revisions r
          JOIN structure_plan_types t ON t.id=r.type_id JOIN structure_plan_files f ON f.revision_id=r.id
          JOIN structure_plan_processing p ON p.revision_id=r.id
          WHERE r.source=? AND t.name=? AND f.sha256=? AND p.processing_json=? LIMIT 1`)
          .bind(source.sourceUrl, type.label, model.sha256, JSON.stringify(processing)).first<{id: string; complexId: string}>();
        if (existing) revision = existing;
        else {
          const response = await image(source, type);
          if (!response.ok) throw new Error("원본 이미지를 불러오지 못했습니다.");
          const bytes = await response.arrayBuffer();
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
          if (digest !== model.sha256) throw new Error("검토한 원본과 파일이 달라 자동 연결을 중단했습니다.");
          const complex = await db.prepare("SELECT id FROM structure_complexes WHERE name=? AND address=? ORDER BY id LIMIT 1")
            .bind(source.name, source.address).first<{id:string}>();
          const complexId = complex?.id ?? crypto.randomUUID();
          const storedType = complex ? await db.prepare("SELECT id FROM structure_plan_types WHERE complex_id=? AND name=?")
            .bind(complexId, type.label).first<{id:string}>() : null;
          const typeId = storedType?.id ?? crypto.randomUUID(), id = crypto.randomUUID();
          const file = await uploadPlanFile(new Request("https://internal.invalid/plan", {
            method: "POST", body: bytes, headers: {
              "Content-Type": response.headers.get("content-type")!,
              "X-File-Size": String(bytes.byteLength), "X-File-SHA256": digest,
              "X-File-Name": encodeURIComponent(`${source.name}-${type.label}-기본형.jpg`),
            },
          }), bucket, id);
          const statements: D1PreparedStatement[] = [];
          if (!complex) statements.push(db.prepare("INSERT INTO structure_complexes(id,name,address,evidence) VALUES(?,?,?,?)").bind(complexId,source.name,source.address,source.sourceUrl));
          if (!storedType) statements.push(db.prepare("INSERT INTO structure_plan_types(id,complex_id,name) VALUES(?,?,?)").bind(typeId,complexId,type.label));
          statements.push(
            db.prepare(`INSERT INTO structure_plan_revisions(id,type_id,version,geometry_json,source,permission_evidence,variant)
              SELECT ?,?,COALESCE(MAX(version),0)+1,'null',?,'','base' FROM structure_plan_revisions WHERE type_id=?`).bind(id,typeId,source.sourceUrl,typeId),
            db.prepare("INSERT INTO structure_plan_files(revision_id,storage_key,file_name,mime_type,byte_size,sha256) VALUES(?,?,?,?,?,?)").bind(id,file.storage_key,file.file_name,file.mime_type,file.byte_size,file.sha256),
            db.prepare("INSERT INTO structure_plan_processing(revision_id,processing_json) VALUES(?,?)").bind(id,JSON.stringify(processing)),
          );
          try { await db.batch(statements); }
          catch (error) { await bucket.delete(file.storage_key).catch(() => {}); throw error; }
          revision = { id, complexId }; result.registered++;
        }
        revisions.set(type.id, revision);
      }
      const storedBuilding = await db.prepare("SELECT id FROM structure_buildings WHERE complex_id=? AND name=?")
        .bind(revision.complexId, dong).first<{id:string}>();
      const buildingId = storedBuilding?.id ?? crypto.randomUUID();
      const storedUnit = storedBuilding ? await db.prepare("SELECT id FROM structure_units WHERE building_id=? AND number=?")
        .bind(buildingId,row.unit_number).first<{id:string}>() : null;
      if (storedUnit && await db.prepare("SELECT unit_id FROM structure_assignments WHERE unit_id=?").bind(storedUnit.id).first()) {
        result.skipped++; continue;
      }
      const unitId = storedUnit?.id ?? crypto.randomUUID();
      const evidence = `공개 동별 단일 타입과 현재 장부 표기 대조: ${building.sourceUrl}. 호수별 방향·확장·리모델링 미확인.`;
      const statements: D1PreparedStatement[] = [];
      if (!storedBuilding) statements.push(db.prepare("INSERT INTO structure_buildings(id,complex_id,name) VALUES(?,?,?)").bind(buildingId,revision.complexId,dong));
      if (!storedUnit) statements.push(db.prepare("INSERT INTO structure_units(id,building_id,number,floor,evidence) VALUES(?,?,?,NULL,?)")
        .bind(unitId,buildingId,row.unit_number,evidence));
      statements.push(
        db.prepare("INSERT INTO structure_assignments(unit_id,revision_id,mirror,rotation,actual_condition,evidence) VALUES(?,?,NULL,NULL,'unknown',?)").bind(unitId,revision.id,evidence),
        // Re-check the source record in the transaction. A changed/closed listing
        // causes a NOT NULL failure and rolls back this unit's entire batch.
        db.prepare(`INSERT INTO structure_listing_links(identity_key,unit_id,evidence) VALUES(?,
          CASE WHEN EXISTS(SELECT 1 FROM listings WHERE identity_key=? AND property_type='아파트'
          AND closed_at IS NULL AND is_demo=0 AND building_name=? AND building_dong=? AND unit_number=? AND size_type=?) THEN ? ELSE NULL END,?)`)
          .bind(row.identity_key,row.identity_key,row.building_name,row.building_dong,row.unit_number,row.size_type,unitId,evidence),
        db.prepare("INSERT INTO structure_audit(id,entity_id,action,details) VALUES(?,?,?,?)")
          .bind(crypto.randomUUID(),unitId,"public-plan.imported",JSON.stringify({revisionId:revision.id,source:source.sourceUrl,typeId:type.id,identityKey:row.identity_key,orientation:"unknown",condition:"unknown"})),
      );
      await db.batch(statements);
      result.linked++;
      result.firstIdentityKey ||= row.identity_key;
    } catch {
      result.errors.push({ property: `${row.building_name} ${row.building_dong}동 ${row.unit_number}호`, message: "연결하지 못했습니다. 원본 또는 최신 연결 상태를 확인해 주세요." });
    }
  }
  return result;
}
