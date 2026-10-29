import { getD1 } from ".";
import { STRUCTURE_SCHEMA } from "./structure-schema.js";

const WORK_TYPES = [
  "전화", "매물등록", "매물수정", "집방문예약", "집방문예정", "집방문",
  "인테리어방문예약", "인테리어방문예정", "인테리어방문", "청소예약", "청소예정", "청소",
  "내방", "타계약확인", "매물취소", "가계약", "계약서예정", "계약서작성",
  "잔금예정", "잔금", "중도금예정", "중도금", "계약파기", "예약변경", "예약취소",
  "기타", "경매예정", "경매확인", "내방예약", "계약취소",
];

const BUILDINGS: Record<string, string[]> = {
  아파트: [
    "아이파크1차", "힐스테이트1차", "우방2차", "아이파크2차", "힐스테이트2차",
    "모아미래도엘리트파크", "대림e편한", "현대", "우방1차", "검단피오레", "동아",
    "드림파크어울림1단지", "당하풍림3차", "마전풍림3차", "검암풍림3차", "금호어울림",
    "영남탑스빌", "유호", "마전하나", "우방3차(검단오류)", "삼라마이다스", "힐스테이트4차",
    "마전동남", "우림필유", "영진", "미래지향", "양우내안에", "검단풍림2차",
    "오류힐스테이트2차", "당하KCC",
  ],
  빌라: [
    "중앙E클래스20차", "로하스타운(왕길동)", "남두아이빌", "모드니빌", "삼성캐슬(마전지구)",
    "NL빌리지(마전지구)", "힐스타운(마전지구)", "힐스타운빌라(왕길동)", "아침애(마전지구)",
    "미가애(마전지구)", "다채움(마전지구)", "현대빌리지(마전지구)", "삼성타운(마전지구)",
    "대명빌라(연희동)", "ES캐슬(마전지구)", "가현그랑빌(마전지구)",
    "시엔엠파크(마전지구)", "신동아홈타운(마전지구)",
  ],
  상가: [
    "아이파크1차 상가", "힐스테이트1차 상가", "우방2차 상가", "아이파크2차 상가",
    "힐스테이트2차 상가", "스타빌(마전동 995-5) 상가", "상가", "남파라곤 상가",
    "연세9차(아라동)", "더안 타운하우스(원당)", "월빙메디칼프라자(원당)",
    "당하풍림3차 상가", "영남탑스빌 상가", "대주피오레 상가", "e편한아파트 상가",
  ],
  오피스텔: ["듀클래스", "아침에캐슬(원당동)", "튜클렉스3", "튜클렉스4", "튜클렉스5", "튜클렉스6", "튜클렉스7", "튜클렉스8", "튜클렉스9"],
  다가구: ["행복타운", "스위트빌", "이레빌", "초롱빌4", "초롱빌5", "초롱빌6", "초롱빌7", "초롱빌8", "초롱빌9", "초롱빌10", "초롱빌11"],
  토지: ["토지"],
};

const schemaStatements = [
  ...STRUCTURE_SCHEMA,
  `CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS work_logs (
    id TEXT PRIMARY KEY, legacy_id INTEGER, work_date TEXT NOT NULL, customer_id TEXT NOT NULL,
    work_type TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  )`,
  `CREATE TABLE IF NOT EXISTS work_log_properties (
    id TEXT PRIMARY KEY, work_log_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    property_type TEXT NOT NULL DEFAULT '', building_name TEXT NOT NULL DEFAULT '',
    building_dong TEXT NOT NULL DEFAULT '', unit_number TEXT NOT NULL DEFAULT '', size_type TEXT NOT NULL DEFAULT '',
    sale_price TEXT NOT NULL DEFAULT '', jeonse_price TEXT NOT NULL DEFAULT '', monthly_rent TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '', FOREIGN KEY (work_log_id) REFERENCES work_logs(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE, registered_at TEXT, closed_at TEXT, status TEXT NOT NULL,
    property_type TEXT NOT NULL, building_name TEXT NOT NULL, building_dong TEXT NOT NULL DEFAULT '',
    unit_number TEXT NOT NULL DEFAULT '', size_type TEXT NOT NULL DEFAULT '', sale_price TEXT NOT NULL DEFAULT '',
    jeonse_price TEXT NOT NULL DEFAULT '', monthly_rent TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
    source_notes TEXT NOT NULL DEFAULT '', is_demo INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS listing_source_notes (
    identity_key TEXT PRIMARY KEY, source_notes TEXT NOT NULL DEFAULT '',
    event_history TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT listing_source_notes_event_history_array CHECK(json_valid(event_history) AND json_type(event_history) = 'array')
  )`,
  `CREATE TABLE IF NOT EXISTS listing_events (
    id TEXT PRIMARY KEY, listing_key TEXT NOT NULL, work_log_id TEXT NOT NULL, detail_id TEXT NOT NULL UNIQUE,
    event_date TEXT NOT NULL, event_order INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
    property_type TEXT NOT NULL, building_name TEXT NOT NULL,
    building_dong TEXT NOT NULL DEFAULT '', unit_number TEXT NOT NULL DEFAULT '', size_type TEXT NOT NULL DEFAULT '',
    sale_price TEXT NOT NULL DEFAULT '', jeonse_price TEXT NOT NULL DEFAULT '', monthly_rent TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (work_log_id) REFERENCES work_logs(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS work_types (name TEXT PRIMARY KEY, sort_order INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS property_buildings (
    id TEXT PRIMARY KEY, property_type TEXT NOT NULL, building_name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(property_type, building_name)
  )`,
  `CREATE TABLE IF NOT EXISTS auth_attempts (
    key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS follow_ups (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', due_date TEXT,
    customer_id TEXT, listing_key TEXT, completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT follow_ups_title_length CHECK(length(trim(title)) BETWEEN 1 AND 200),
    CONSTRAINT follow_ups_notes_length CHECK(length(notes) <= 5000),
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS trash_records (
    id TEXT PRIMARY KEY, entity_type TEXT NOT NULL CHECK(entity_type IN ('work', 'customer', 'followup')),
    entity_id TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '',
    search_text TEXT NOT NULL DEFAULT '', snapshot TEXT NOT NULL,
    deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_trash_records_entity ON trash_records(entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trash_records_deleted ON trash_records(deleted_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_follow_ups_completed_due ON follow_ups(completed_at, due_date)`,
  `CREATE INDEX IF NOT EXISTS idx_follow_ups_customer ON follow_ups(customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_work_logs_date_updated_id ON work_logs(work_date, updated_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_work_logs_customer_date_updated_id ON work_logs(customer_id, work_date, updated_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_work_logs_type_date_updated_id ON work_logs(work_type, work_date, updated_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_work_log_properties_log ON work_log_properties(work_log_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS idx_work_log_properties_address ON work_log_properties(building_name, building_dong, unit_number)`,
  `CREATE INDEX IF NOT EXISTS idx_work_log_properties_source_log ON work_log_properties(trim(source), work_log_id)`,
  `CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(closed_at, status)`,
  `CREATE INDEX IF NOT EXISTS idx_listings_building ON listings(property_type, building_name)`,
  `CREATE INDEX IF NOT EXISTS idx_listing_events_key_date ON listing_events(listing_key, event_date)`,
  `CREATE INDEX IF NOT EXISTS idx_listing_events_work_log ON listing_events(work_log_id)`,
];

// Bump when bootstrap schema or default lookup definitions change. Runtime
// metadata is deliberately not business data and is not included in backups.
const BOOTSTRAP_VERSION = "4";
const schemaNames = schemaStatements.map((statement) => {
  const name = statement.match(/^CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS (\w+)/)?.[1];
  if (!name) throw new Error("Invalid bootstrap schema statement");
  return name;
});
// Cache only completed readiness, not an in-flight D1 request. Worker I/O is
// request-scoped: if its originating request is cancelled, sharing that pending
// promise can leave unrelated requests waiting forever. Cold requests may each
// do the cheap readiness read; warm requests still require no extra DB calls.
const initializedDatabases = new WeakSet<D1Database>();

export async function ensureDatabase(db: D1Database = getD1()): Promise<void> {
  if (initializedDatabases.has(db)) return;
  await initialize(db);
  initializedDatabases.add(db);
}

async function initialize(db: D1Database) {
  // A cold Worker only needs this read when initialization already succeeded.
  // Checking the required schema also catches a restored/partially migrated DB
  // whose runtime marker was retained but whose tables or indexes are missing.
  try {
    const ready = await db.prepare(`SELECT value FROM app_runtime_state
      WHERE key = 'bootstrap_version' AND value = ?
        AND (SELECT COUNT(*) FROM sqlite_master
          WHERE name IN (${schemaNames.map(() => "?").join(",")}) AND type IN ('table', 'index')) = ?`)
      .bind(BOOTSTRAP_VERSION, ...schemaNames, schemaNames.length).first();
    if (ready) return;
  } catch (error) {
    if (!/no such table:\s*(?:main\.)?app_runtime_state\b/i.test(String(error))) throw error;
  }

  const existing = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('customers', 'work_logs', 'work_log_properties', 'listings', 'listing_events', 'follow_ups')`)
    .all<{ name: string }>();
  // An empty real database is still real. Only a genuinely new, uninitialized
  // database may receive examples; deleting/importing records never re-seeds it.
  const isNewDatabase = existing.results.length === 0;
  await db.batch(schemaStatements.map((statement) => db.prepare(statement)));

  const lookupSeeds: D1PreparedStatement[] = WORK_TYPES.map((name, index) =>
    db.prepare("INSERT OR IGNORE INTO work_types (name, sort_order) VALUES (?, ?)").bind(name, index + 1),
  );
  for (const [propertyType, names] of Object.entries(BUILDINGS)) {
    names.forEach((name, index) => lookupSeeds.push(
      db.prepare("INSERT OR IGNORE INTO property_buildings (id, property_type, building_name, sort_order) VALUES (?, ?, ?, ?)")
        .bind(`base-${propertyType}-${index + 1}`, propertyType, name, index + 1),
    ));
  }
  await db.batch(lookupSeeds);

  if (isNewDatabase) await seedDemo(db);
  // Do not overwrite a pruned empty tombstone on cold starts or restored DBs.
  await db.prepare(`INSERT OR IGNORE INTO listing_source_notes (identity_key, source_notes, event_history)
    SELECT l.identity_key, l.source_notes, (SELECT json_group_array(json_object(
      'work_log_id', e.work_log_id, 'event_date', e.event_date, 'status', e.status, 'notes', e.notes))
      FROM listing_events e WHERE e.listing_key = l.identity_key)
    FROM listings l WHERE l.source_notes <> ''`).run();
  await db.prepare("PRAGMA optimize").run();
  // Write last so every failure remains retryable, including lookup/demo writes.
  await db.prepare(`INSERT INTO app_runtime_state (key, value) VALUES ('bootstrap_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(BOOTSTRAP_VERSION).run();
}

async function seedDemo(db: D1Database) {
  const statements = [
    db.prepare("INSERT OR IGNORE INTO customers (id, name, notes, is_demo) VALUES (?, ?, ?, 1)").bind("DEMO-001", "김민수 (예시)", "33평 전세를 찾는 고객"),
    db.prepare("INSERT OR IGNORE INTO customers (id, name, notes, is_demo) VALUES (?, ?, ?, 1)").bind("DEMO-002", "한지영 (예시)", "입주일 협의 필요"),
    db.prepare("INSERT OR IGNORE INTO customers (id, name, notes, is_demo) VALUES (?, ?, ?, 1)").bind("DEMO-003", "우리동네부동산 (예시)", "공동중개 연락처"),
    db.prepare("INSERT OR IGNORE INTO customers (id, name, notes, is_demo) VALUES (?, ?, ?, 1)").bind("DEMO-004", "계약고객 (예시)", "잔금 일정 확인"),
    db.prepare("INSERT OR IGNORE INTO work_logs (id, work_date, customer_id, work_type, content, is_demo) VALUES ('demo-reg-1', date('now','+9 hours','-20 days'), 'DEMO-003', '매물등록', '전세 매물 등록', 1)"),
    db.prepare("INSERT OR IGNORE INTO work_logs (id, work_date, customer_id, work_type, content, is_demo) VALUES ('demo-today-1', date('now','+9 hours'), 'DEMO-001', '집방문예약', '오전 방문 약속', 1)"),
    db.prepare("INSERT OR IGNORE INTO work_logs (id, work_date, customer_id, work_type, content, is_demo) VALUES ('demo-today-2', date('now','+9 hours'), 'DEMO-002', '전화', '아파트 전세 문의 상담', 1)"),
    db.prepare("INSERT OR IGNORE INTO work_logs (id, work_date, customer_id, work_type, content, is_demo) VALUES ('demo-today-3', date('now','+9 hours'), 'DEMO-003', '매물등록', '신규 매매 매물 등록', 1)"),
    db.prepare("INSERT OR IGNORE INTO work_logs (id, work_date, customer_id, work_type, content, is_demo) VALUES ('demo-upcoming-1', date('now','+9 hours','+3 days'), 'DEMO-004', '잔금예정', '잔금 시간 확인 필요', 1)"),
    db.prepare("INSERT OR IGNORE INTO work_log_properties (id, work_log_id, sequence, property_type, building_name, building_dong, unit_number, size_type, jeonse_price, source) VALUES ('demo-detail-reg-1','demo-reg-1',1,'아파트','아이파크1차','101','1203','33','2억 7,000','단독')"),
    db.prepare("INSERT OR IGNORE INTO work_log_properties (id, work_log_id, sequence, property_type, building_name, building_dong, unit_number, size_type, jeonse_price, source) VALUES ('demo-detail-today-1','demo-today-1',1,'아파트','아이파크1차','101','1203','33','2억 7,000','단독')"),
    db.prepare("INSERT OR IGNORE INTO work_log_properties (id, work_log_id, sequence, property_type, building_name, building_dong, unit_number, size_type, sale_price, source) VALUES ('demo-detail-today-3','demo-today-3',1,'아파트','힐스테이트1차','204','802','40','6억 2,000','우리동네부동산')"),
    db.prepare("INSERT OR IGNORE INTO work_log_properties (id, work_log_id, sequence, property_type, building_name, building_dong, unit_number, size_type, sale_price, source) VALUES ('demo-detail-upcoming-1','demo-upcoming-1',1,'아파트','우방2차','103','501','35','4억 8,000','공동중개')"),
    db.prepare("INSERT OR IGNORE INTO listing_events (id, listing_key, work_log_id, detail_id, event_date, event_order, status, property_type, building_name, building_dong, unit_number, size_type, jeonse_price, source, notes, is_demo) VALUES ('demo-event-reg-1','아파트|아이파크1차|101|1203','demo-reg-1','demo-detail-reg-1',date('now','+9 hours','-20 days'),1,'매물등록','아파트','아이파크1차','101','1203','33','2억 7,000','단독','전세 매물 등록',1)"),
    db.prepare("INSERT OR IGNORE INTO listing_events (id, listing_key, work_log_id, detail_id, event_date, event_order, status, property_type, building_name, building_dong, unit_number, size_type, sale_price, source, notes, is_demo) VALUES ('demo-event-today-3','아파트|힐스테이트1차|204|802','demo-today-3','demo-detail-today-3',date('now','+9 hours'),2,'매물등록','아파트','힐스테이트1차','204','802','40','6억 2,000','우리동네부동산','신규 매매 매물 등록',1)"),
    db.prepare(`INSERT OR IGNORE INTO listings (id, identity_key, registered_at, status, property_type, building_name, building_dong, unit_number, size_type, jeonse_price, notes, is_demo)
      VALUES ('demo-listing-1','아파트|아이파크1차|101|1203',date('now','+9 hours','-20 days'),'매물등록','아파트','아이파크1차','101','1203','33','2억 7,000','전세 매물 등록 (매물등록)',1)`),
    db.prepare(`INSERT OR IGNORE INTO listings (id, identity_key, registered_at, status, property_type, building_name, building_dong, unit_number, size_type, sale_price, notes, is_demo)
      VALUES ('demo-listing-2','아파트|힐스테이트1차|204|802',date('now','+9 hours'),'매물등록','아파트','힐스테이트1차','204','802','40','6억 2,000','신규 매매 매물 등록 (매물등록)',1)`),
  ];
  await db.batch(statements);
}
