import { getD1 } from "../../../db";
import { clean, isPropertyComplete, listingKey, LISTING_WORK_TYPES, listingRebuildStatements, type PropertyInput } from "../../../db/listing-sync";
import { normalizeDate } from "../_shared";
import { moveToTrash } from "../../../db/deletion-store";

export type WorkLogPayload = {
  workDate?: string;
  customerId?: string;
  workType?: string;
  content?: string;
  details?: PropertyInput[];
  revision?: unknown;
};

const detailColumns = `id, work_log_id, sequence, property_type, building_name, building_dong, unit_number,
  size_type, sale_price, jeonse_price, monthly_rent, source`;

// One deterministic snapshot covers the header and all rows used to rebuild
// listings. It is checked again inside the write batch, not just before it.
const snapshotSql = `SELECT json_object(
  'work', json_object('id', w.id, 'legacy_id', w.legacy_id, 'work_date', w.work_date,
    'customer_id', w.customer_id, 'work_type', w.work_type, 'content', w.content,
    'is_demo', w.is_demo, 'created_at', w.created_at, 'updated_at', w.updated_at),
  'details', json((SELECT json_group_array(json(value)) FROM (
    SELECT json_object('id', p.id, 'sequence', p.sequence, 'property_type', p.property_type,
      'building_name', p.building_name, 'building_dong', p.building_dong, 'unit_number', p.unit_number,
      'size_type', p.size_type, 'sale_price', p.sale_price, 'jeonse_price', p.jeonse_price,
      'monthly_rent', p.monthly_rent, 'source', p.source) AS value
    FROM work_log_properties p WHERE p.work_log_id = w.id ORDER BY p.sequence, p.id))),
  'events', json((SELECT json_group_array(json(value)) FROM (
    SELECT json_object('id', e.id, 'listing_key', e.listing_key, 'detail_id', e.detail_id,
      'event_order', e.event_order) AS value FROM listing_events e
    WHERE e.work_log_id = w.id ORDER BY e.id)))
) AS snapshot FROM work_logs w WHERE w.id = ?`;

async function revisionFor(snapshot: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const editConflict = "다른 기기에서 업무가 변경되었거나 삭제되었습니다. 작성 내용을 복사한 뒤 창을 닫고 최신 업무를 다시 확인해 주세요.";

export async function getWorkLog(id: string) {
  const db = getD1();
  const [headers, details, snapshots] = await db.batch([
    db.prepare(`
      SELECT w.*, c.name AS customer_name FROM work_logs w JOIN customers c ON c.id = w.customer_id WHERE w.id = ?
    `).bind(id),
    db.prepare(`SELECT ${detailColumns} FROM work_log_properties WHERE work_log_id = ? ORDER BY sequence`).bind(id),
    db.prepare(snapshotSql).bind(id),
  ]);
  const workLog = headers.results[0];
  if (!workLog) return null;
  const snapshot = snapshots.results[0] as { snapshot: string };
  return { ...workLog, details: details.results, revision: await revisionFor(snapshot.snapshot) };
}

export async function saveWorkLog(payload: WorkLogPayload, existingId?: string) {
  const db = getD1();
  const workDate = normalizeDate(clean(payload.workDate));
  const customerId = clean(payload.customerId);
  const workType = clean(payload.workType);
  const content = clean(payload.content);
  if (Array.isArray(payload.details) && payload.details.length > 10) {
    throw new InputError("연결 물건은 최대 10개까지 입력할 수 있습니다.");
  }
  const details = (Array.isArray(payload.details) ? payload.details : []).map((detail) => ({
    propertyType: clean(detail.propertyType),
    buildingName: clean(detail.buildingName),
    buildingDong: clean(detail.buildingDong),
    unitNumber: clean(detail.unitNumber),
    sizeType: clean(detail.sizeType),
    salePrice: clean(detail.salePrice),
    jeonsePrice: clean(detail.jeonsePrice),
    monthlyRent: clean(detail.monthlyRent),
    source: clean(detail.source),
  })).filter((detail) => Object.values(detail).some(Boolean));

  if (!workDate || !customerId || !workType) {
    throw new InputError("일자, 고객, 업무구분은 필수입니다.");
  }
  const [customer, validWorkType] = await Promise.all([
    db.prepare("SELECT id FROM customers WHERE id = ?").bind(customerId).first(),
    db.prepare("SELECT name FROM work_types WHERE name = ?").bind(workType).first(),
  ]);
  if (!customer) throw new InputError("먼저 고객을 등록해 주세요.");
  if (!validWorkType) throw new InputError("등록된 업무구분을 선택해 주세요.");
  if (LISTING_WORK_TYPES.has(workType) && (details.length === 0 || details.some((detail) => !isPropertyComplete(detail)))) {
    throw new InputError("매물 상태를 바꾸는 업무는 물건구분, 건물명, 호수를 입력해 주세요.");
  }

  const id = existingId ?? crypto.randomUUID();
  const affectedKeys = new Set<string>();
  const existingOrderBySequence = new Map<number, number>();
  let legacyId: number | null = null;
  let snapshot: string | undefined;

  if (existingId) {
    if (typeof payload.revision !== "string" || !/^[a-f0-9]{64}$/.test(payload.revision)) {
      throw new InputError("수정할 업무를 다시 열어 최신 내용을 확인해 주세요.");
    }
    const [existingWorkRows, existingEvents, snapshotRows] = await db.batch([
      db.prepare("SELECT legacy_id FROM work_logs WHERE id = ?").bind(existingId),
      db.prepare(`
        SELECT e.listing_key, e.event_order, p.sequence
        FROM listing_events e
        LEFT JOIN work_log_properties p ON p.id = e.detail_id
        WHERE e.work_log_id = ?
      `).bind(existingId),
      db.prepare(snapshotSql).bind(existingId),
    ]);
    const existingWork = existingWorkRows.results[0] as { legacy_id: number | null } | undefined;
    if (!existingWork) throw new InputError("수정할 업무를 찾을 수 없습니다.", 404);
    snapshot = (snapshotRows.results[0] as { snapshot: string }).snapshot;
    if (await revisionFor(snapshot) !== payload.revision) throw new InputError(editConflict, 409);
    legacyId = existingWork.legacy_id;
    (existingEvents.results as { listing_key: string; event_order: number; sequence: number | null }[]).forEach((row) => {
      affectedKeys.add(row.listing_key);
      if (row.sequence != null) existingOrderBySequence.set(row.sequence, Number(row.event_order));
    });
  }

  const headerStatement = existingId
    ? db.prepare(`INSERT INTO work_logs (id, work_date, customer_id, work_type, content, is_demo)
        VALUES (?, ?, ?, ?, CASE WHEN (${snapshotSql}) = ? THEN ? ELSE NULL END, 0)
        ON CONFLICT(id) DO UPDATE SET work_date = excluded.work_date, customer_id = excluded.customer_id,
          work_type = excluded.work_type, content = excluded.content, is_demo = 0, updated_at = CURRENT_TIMESTAMP`)
      .bind(existingId, workDate, customerId, workType, existingId, snapshot, content)
    : db.prepare("INSERT INTO work_logs (id, work_date, customer_id, work_type, content, is_demo) VALUES (?, ?, ?, ?, ?, 0)")
      .bind(id, workDate, customerId, workType, content);
  const statements = [headerStatement];
  if (existingId) {
    statements.push(
      db.prepare("DELETE FROM listing_events WHERE work_log_id = ?").bind(existingId),
      db.prepare("DELETE FROM work_log_properties WHERE work_log_id = ?").bind(existingId),
    );
  }

  const generatedOrderBase = legacyId == null ? Date.now() * 100 : legacyId * 100;
  details.forEach((detail, index) => {
    const sequence = index + 1;
    const detailId = crypto.randomUUID();
    statements.push(db.prepare(`
      INSERT INTO work_log_properties (
        id, work_log_id, sequence, property_type, building_name, building_dong, unit_number,
        size_type, sale_price, jeonse_price, monthly_rent, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      detailId, id, sequence, detail.propertyType, detail.buildingName, detail.buildingDong,
      detail.unitNumber, detail.sizeType, detail.salePrice, detail.jeonsePrice, detail.monthlyRent, detail.source,
    ));

    if (LISTING_WORK_TYPES.has(workType) && isPropertyComplete(detail)) {
      const key = listingKey(detail);
      affectedKeys.add(key);
      statements.push(db.prepare(`
        INSERT INTO listing_events (
          id, listing_key, work_log_id, detail_id, event_date, event_order, status, property_type, building_name,
          building_dong, unit_number, size_type, sale_price, jeonse_price, monthly_rent, source, notes, is_demo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).bind(
        crypto.randomUUID(), key, id, detailId, workDate,
        existingOrderBySequence.get(sequence) ?? generatedOrderBase + sequence,
        workType, detail.propertyType, detail.buildingName,
        detail.buildingDong, detail.unitNumber, detail.sizeType, detail.salePrice, detail.jeonsePrice,
        detail.monthlyRent, detail.source, content,
      ));
    }
  });
  try {
    await db.batch([...statements, ...listingRebuildStatements(affectedKeys)]);
  } catch (error) {
    // The first statement deliberately violates this constraint if the record
    // changed or disappeared between the snapshot read and the transaction.
    if (existingId && /NOT NULL constraint failed: work_logs\.content/i.test(String(error))) {
      throw new InputError(editConflict, 409);
    }
    throw error;
  }
  return getWorkLog(id);
}

export async function removeWorkLog(id: string, revision: unknown) {
  return moveToTrash(getD1(), "work", id, revision);
}

export class InputError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}
