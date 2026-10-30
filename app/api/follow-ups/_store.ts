export type FollowUpItem = {
  id: string;
  title: string;
  notes: string;
  due_date: string | null;
  customer_id: string | null;
  listing_key: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  customer_name: string | null;
  listing_label: string | null;
  revision: string;
};

type FollowUpInput = {
  title?: string;
  notes?: string;
  dueDate?: string | null;
  customerId?: string | null;
  listingKey?: string | null;
  completed?: boolean;
  revision?: string;
};

export class FollowUpError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "FollowUpError";
    this.status = status;
  }
}

export function parseFollowUpInput(body: unknown, patch = false): FollowUpInput {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new FollowUpError("할 일 정보를 올바르게 입력해 주세요.");
  }
  const record = body as Record<string, unknown>;
  const allowed = ["title", "notes", "dueDate", "customerId", "listingKey", ...(patch ? ["completed", "revision"] : [])];
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new FollowUpError("지원하지 않는 할 일 항목이 있습니다.");
  }
  if (patch && Object.keys(record).length === 0) throw new FollowUpError("변경할 내용을 입력해 주세요.");

  const input: FollowUpInput = {};
  if (patch) {
    if (typeof record.revision !== "string" || !/^[a-f0-9]{64}$/.test(record.revision)) {
      throw new FollowUpError("작성 내용을 복사한 뒤 새로고침하고 할 일을 다시 열어 최신 내용을 확인해 주세요.");
    }
    if (!Object.keys(record).some((key) => key !== "revision")) throw new FollowUpError("변경할 내용을 입력해 주세요.");
    input.revision = record.revision;
  }
  if (!patch || "title" in record) {
    if (typeof record.title !== "string" || !record.title.trim() || record.title.trim().length > 200) {
      throw new FollowUpError("할 일 제목은 1~200자로 입력해 주세요.");
    }
    input.title = record.title.trim();
  }
  if ("notes" in record) {
    if (typeof record.notes !== "string" || record.notes.length > 5000) {
      throw new FollowUpError("메모는 5,000자 이내로 입력해 주세요.");
    }
    input.notes = record.notes.trim();
  }
  if ("dueDate" in record) {
    const date = nullableText(record.dueDate, "기한", 10);
    if (date && !isCalendarDate(date)) throw new FollowUpError("기한을 올바른 날짜로 입력해 주세요.");
    input.dueDate = date;
  }
  if ("customerId" in record) input.customerId = nullableText(record.customerId, "고객", 200);
  if ("listingKey" in record) input.listingKey = nullableText(record.listingKey, "매물", 1000);
  if ("completed" in record) {
    if (typeof record.completed !== "boolean") throw new FollowUpError("완료 여부를 올바르게 선택해 주세요.");
    input.completed = record.completed;
  }
  return input;
}

function nullableText(value: unknown, label: string, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length > max) {
    throw new FollowUpError(`${label} 정보를 올바르게 입력해 주세요.`);
  }
  return value.trim() || null;
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function seoulToday(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const ITEM_SQL = `SELECT f.*, c.name AS customer_name,
  CASE WHEN l.identity_key IS NOT NULL THEN
    trim(l.building_name || CASE WHEN l.building_dong <> '' THEN ' ' || l.building_dong || '동' ELSE '' END
      || CASE WHEN l.unit_number <> '' THEN ' ' || l.unit_number || '호' ELSE '' END)
    ELSE NULL END AS listing_label
  FROM follow_ups f
  LEFT JOIN customers c ON c.id = f.customer_id
  LEFT JOIN listings l ON l.identity_key = f.listing_key`;

type FollowUpRow = Omit<FollowUpItem, "revision">;
async function withRevision(item: FollowUpRow): Promise<FollowUpItem> {
  // Include every persisted value, so same-second edits and completed toggles
  // are covered without depending on timestamp precision or joined labels.
  const values = [item.id, item.title, item.notes, item.due_date, item.customer_id,
    item.listing_key, item.completed_at, item.created_at, item.updated_at];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(values)));
  const revision = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { ...item, revision };
}

// With an equal deadline, older open tasks retain their place. Completed
// tasks use completion time instead, with the ID breaking any remaining tie.
export const FOLLOW_UP_ORDER = `f.completed_at IS NOT NULL,
  CASE WHEN f.completed_at IS NULL THEN f.due_date IS NULL END,
  CASE WHEN f.completed_at IS NULL THEN f.due_date END,
  f.completed_at DESC, CASE WHEN f.completed_at IS NULL THEN f.created_at END, f.id`;

export async function getFollowUps(db: D1Database, params: URLSearchParams, now = new Date()) {
  const allowed = new Set(["q", "status", "due"]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length > 1) throw new FollowUpError("검색 조건을 확인해 주세요.");
  }
  const q = params.get("q")?.trim() ?? "";
  const status = params.get("status") ?? "open";
  const due = params.get("due") ?? "all";
  if (q.length > 200) throw new FollowUpError("검색어는 200자 이내로 입력해 주세요.");
  if (!["open", "completed", "all"].includes(status) || !["all", "today", "overdue", "upcoming"].includes(due)) {
    throw new FollowUpError("검색 조건을 확인해 주세요.");
  }
  const today = seoulToday(now);
  const endDate = seoulToday(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000));
  const where: string[] = [];
  const bindings: string[] = [];
  if (status === "open") where.push("f.completed_at IS NULL");
  if (status === "completed") where.push("f.completed_at IS NOT NULL");
  if (due === "today") { where.push("f.due_date = ?"); bindings.push(today); }
  if (due === "overdue") { where.push("f.due_date < ?"); bindings.push(today); }
  if (due === "upcoming") { where.push("f.due_date > ? AND f.due_date <= ?"); bindings.push(today, endDate); }
  if (q) {
    const text = textSearch(["f.title", "f.notes", "c.name", "c.id"], q, ["c.id"]);
    const property = propertySearch(q, "l");
    where.push(`(${text.sql} OR ${property.sql})`);
    bindings.push(...text.bindings, ...property.bindings);
  }
  const [items, summary] = await db.batch([
    db.prepare(`${ITEM_SQL} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${FOLLOW_UP_ORDER}`)
      .bind(...bindings),
    db.prepare(`SELECT
      COALESCE(SUM(completed_at IS NULL), 0) AS open,
      COALESCE(SUM(completed_at IS NULL AND due_date < ?), 0) AS overdue,
      COALESCE(SUM(completed_at IS NULL AND due_date = ?), 0) AS today,
      COALESCE(SUM(completed_at IS NOT NULL), 0) AS completed FROM follow_ups`).bind(today, today),
  ]);
  return {
    items: await Promise.all((items.results as FollowUpRow[]).map(withRevision)),
    summary: summary.results[0] as { open: number; overdue: number; today: number; completed: number },
  };
}

export async function getFollowUp(db: D1Database, id: string): Promise<FollowUpItem> {
  const item = await db.prepare(`${ITEM_SQL} WHERE f.id = ?`).bind(id).first<FollowUpRow>();
  if (!item) throw new FollowUpError("할 일을 찾을 수 없습니다.", 404);
  return withRevision(item);
}

async function validateLinks(db: D1Database, input: FollowUpInput): Promise<void> {
  if (input.customerId && !await db.prepare("SELECT id FROM customers WHERE id = ?").bind(input.customerId).first()) {
    throw new FollowUpError("연결할 고객을 찾을 수 없습니다.");
  }
  if (input.listingKey && !await db.prepare("SELECT id FROM listings WHERE identity_key = ?").bind(input.listingKey).first()) {
    throw new FollowUpError("연결할 매물을 찾을 수 없습니다.");
  }
}

export async function createFollowUp(db: D1Database, body: unknown): Promise<FollowUpItem> {
  const input = parseFollowUpInput(body);
  await validateLinks(db, input);
  const id = crypto.randomUUID();
  await db.prepare(`INSERT INTO follow_ups (id, title, notes, due_date, customer_id, listing_key)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(id, input.title!, input.notes ?? "", input.dueDate ?? null,
    input.customerId ?? null, input.listingKey ?? null).run();
  return getFollowUp(db, id);
}

export async function updateFollowUp(db: D1Database, id: string, body: unknown): Promise<FollowUpItem> {
  const input = parseFollowUpInput(body, true);
  const existing = await getFollowUp(db, id);
  const conflict = "다른 기기에서 할 일이 변경되었거나 삭제되었습니다. 작성 내용은 유지됩니다. 최신 할 일을 다시 열어 확인해 주세요.";
  if (input.revision !== existing.revision) throw new FollowUpError(conflict, 409);
  await validateLinks(db, {
    customerId: input.customerId === existing.customer_id ? undefined : input.customerId,
    listingKey: input.listingKey === existing.listing_key ? undefined : input.listingKey,
  });
  const columns = { title: "title", notes: "notes", dueDate: "due_date", customerId: "customer_id", listingKey: "listing_key" } as const;
  const assignments: string[] = [];
  const bindings: (string | null)[] = [];
  for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
    if (input[key] !== undefined) {
      assignments.push(`${columns[key]} = ?`);
      bindings.push(input[key]!);
    }
  }
  if (input.completed !== undefined) assignments.push(input.completed
    ? "completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)" : "completed_at = NULL");
  assignments.push("updated_at = CURRENT_TIMESTAMP");
  const result = await db.prepare(`UPDATE follow_ups SET ${assignments.join(", ")}
    WHERE id = ? AND title = ? AND notes = ? AND due_date IS ? AND customer_id IS ?
      AND listing_key IS ? AND completed_at IS ? AND created_at = ? AND updated_at = ?`)
    .bind(...bindings, id, existing.title, existing.notes, existing.due_date, existing.customer_id,
      existing.listing_key, existing.completed_at, existing.created_at, existing.updated_at).run();
  if (!result.meta.changes) throw new FollowUpError(conflict, 409);
  return getFollowUp(db, id);
}

export async function deleteFollowUp(db: D1Database, id: string, revision: unknown) {
  const { moveToTrash } = await import("../../../db/deletion-store");
  return moveToTrash(db, "followup", id, revision);
}

export async function readFollowUpBody(request: Request): Promise<unknown> {
  try { return await request.json(); }
  catch { throw new FollowUpError("할 일 정보를 올바른 형식으로 보내 주세요."); }
}
import { propertySearch, textSearch } from "../_search.js";
