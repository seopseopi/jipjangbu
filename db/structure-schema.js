/** Additive local/production schema; no demo data is persisted or inferred. */
export const STRUCTURE_TABLES = [
  "structure_complexes",
  "structure_buildings",
  "structure_units",
  "structure_plan_types",
  "structure_plan_revisions",
  "structure_assignments",
  "structure_listing_links",
  "structure_audit",
  "structure_plan_files",
  "structure_plan_processing",
];
export const STRUCTURE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS structure_complexes (id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS structure_buildings (id TEXT PRIMARY KEY, complex_id TEXT NOT NULL REFERENCES structure_complexes(id), name TEXT NOT NULL, UNIQUE(complex_id,name))`,
  `CREATE TABLE IF NOT EXISTS structure_units (id TEXT PRIMARY KEY, building_id TEXT NOT NULL REFERENCES structure_buildings(id), number TEXT NOT NULL, floor INTEGER, evidence TEXT NOT NULL, UNIQUE(building_id,number))`,
  `CREATE TABLE IF NOT EXISTS structure_plan_types (id TEXT PRIMARY KEY, complex_id TEXT NOT NULL REFERENCES structure_complexes(id), name TEXT NOT NULL, UNIQUE(complex_id,name))`,
  `CREATE TABLE IF NOT EXISTS structure_plan_revisions (id TEXT PRIMARY KEY, type_id TEXT NOT NULL REFERENCES structure_plan_types(id), version INTEGER NOT NULL CHECK(version>0), geometry_json TEXT NOT NULL CHECK(json_valid(geometry_json)), source TEXT NOT NULL, permission_evidence TEXT NOT NULL, variant TEXT NOT NULL CHECK(variant IN ('base','expanded','remodeled')), verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(type_id,version))`,
  `CREATE TABLE IF NOT EXISTS structure_assignments (unit_id TEXT PRIMARY KEY REFERENCES structure_units(id), revision_id TEXT NOT NULL REFERENCES structure_plan_revisions(id), mirror INTEGER CHECK(mirror IN (0,1)), rotation REAL, actual_condition TEXT NOT NULL CHECK(actual_condition IN ('unknown','base','expanded','remodeled')), evidence TEXT NOT NULL, row_version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS structure_listing_links (identity_key TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES structure_units(id), evidence TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS structure_audit (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS structure_plan_files (revision_id TEXT PRIMARY KEY REFERENCES structure_plan_revisions(id), storage_key TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL, mime_type TEXT NOT NULL CHECK(mime_type IN ('application/pdf','image/jpeg','image/png')), byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 8 AND 33554432), sha256 TEXT NOT NULL CHECK(length(sha256)=64))`,
  `CREATE TABLE IF NOT EXISTS structure_plan_processing (revision_id TEXT PRIMARY KEY REFERENCES structure_plan_revisions(id), processing_json TEXT NOT NULL CHECK(json_valid(processing_json)), row_version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_structure_links_unit ON structure_listing_links(unit_id)`,
  `CREATE INDEX IF NOT EXISTS idx_structure_revision_type ON structure_plan_revisions(type_id,version)`,
  `CREATE INDEX IF NOT EXISTS idx_structure_audit_entity ON structure_audit(entity_id,created_at)`,
].map((statement) =>
  statement.replaceAll("TEXT PRIMARY KEY", "TEXT PRIMARY KEY NOT NULL"),
);
