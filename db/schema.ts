import { sql } from "drizzle-orm";
export * from "./structure-tables";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  notes: text("notes").notNull().default(""),
  isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const workLogs = sqliteTable(
  "work_logs",
  {
    id: text("id").primaryKey(),
    legacyId: integer("legacy_id"),
    workDate: text("work_date").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    workType: text("work_type").notNull(),
    content: text("content").notNull().default(""),
    isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_work_logs_date_updated_id").on(
      table.workDate,
      table.updatedAt,
      table.id,
    ),
    index("idx_work_logs_customer_date_updated_id").on(
      table.customerId,
      table.workDate,
      table.updatedAt,
      table.id,
    ),
    index("idx_work_logs_type_date_updated_id").on(
      table.workType,
      table.workDate,
      table.updatedAt,
      table.id,
    ),
  ],
);

export const workLogProperties = sqliteTable(
  "work_log_properties",
  {
    id: text("id").primaryKey(),
    workLogId: text("work_log_id")
      .notNull()
      .references(() => workLogs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    propertyType: text("property_type").notNull().default(""),
    buildingName: text("building_name").notNull().default(""),
    buildingDong: text("building_dong").notNull().default(""),
    unitNumber: text("unit_number").notNull().default(""),
    sizeType: text("size_type").notNull().default(""),
    salePrice: text("sale_price").notNull().default(""),
    jeonsePrice: text("jeonse_price").notNull().default(""),
    monthlyRent: text("monthly_rent").notNull().default(""),
    source: text("source").notNull().default(""),
  },
  (table) => [
    index("idx_work_log_properties_log").on(table.workLogId, table.sequence),
    index("idx_work_log_properties_address").on(
      table.buildingName,
      table.buildingDong,
      table.unitNumber,
    ),
    index("idx_work_log_properties_source_log").on(sql`trim(${table.source})`, table.workLogId),
  ],
);

// Original notes are business data independent of the current-listing projection.
export const listingSourceNotes = sqliteTable("listing_source_notes", {
  identityKey: text("identity_key").primaryKey(),
  sourceNotes: text("source_notes").notNull().default(""),
  eventHistory: text("event_history").notNull().default("[]"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("listing_source_notes_event_history_array", sql`json_valid(${table.eventHistory}) AND json_type(${table.eventHistory}) = 'array'`),
]);

export const listings = sqliteTable(
  "listings",
  {
    id: text("id").primaryKey(),
    identityKey: text("identity_key").notNull(),
    registeredAt: text("registered_at"),
    closedAt: text("closed_at"),
    status: text("status").notNull(),
    propertyType: text("property_type").notNull(),
    buildingName: text("building_name").notNull(),
    buildingDong: text("building_dong").notNull().default(""),
    unitNumber: text("unit_number").notNull().default(""),
    sizeType: text("size_type").notNull().default(""),
    salePrice: text("sale_price").notNull().default(""),
    jeonsePrice: text("jeonse_price").notNull().default(""),
    monthlyRent: text("monthly_rent").notNull().default(""),
    notes: text("notes").notNull().default(""),
    sourceNotes: text("source_notes").notNull().default(""),
    isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_listings_identity").on(table.identityKey),
    index("idx_listings_status").on(table.closedAt, table.status),
    index("idx_listings_building").on(table.propertyType, table.buildingName),
  ],
);

export const listingEvents = sqliteTable(
  "listing_events",
  {
    id: text("id").primaryKey(),
    listingKey: text("listing_key").notNull(),
    workLogId: text("work_log_id")
      .notNull()
      .references(() => workLogs.id, { onDelete: "cascade" }),
    detailId: text("detail_id").notNull(),
    eventDate: text("event_date").notNull(),
    eventOrder: integer("event_order").notNull().default(0),
    status: text("status").notNull(),
    propertyType: text("property_type").notNull(),
    buildingName: text("building_name").notNull(),
    buildingDong: text("building_dong").notNull().default(""),
    unitNumber: text("unit_number").notNull().default(""),
    sizeType: text("size_type").notNull().default(""),
    salePrice: text("sale_price").notNull().default(""),
    jeonsePrice: text("jeonse_price").notNull().default(""),
    monthlyRent: text("monthly_rent").notNull().default(""),
    source: text("source").notNull().default(""),
    notes: text("notes").notNull().default(""),
    isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_listing_events_detail").on(table.detailId),
    index("idx_listing_events_key_date").on(table.listingKey, table.eventDate),
    index("idx_listing_events_key_date_order").on(
      table.listingKey,
      table.eventDate,
      table.eventOrder,
    ),
    index("idx_listing_events_work_log").on(table.workLogId),
  ],
);

export const workTypes = sqliteTable("work_types", {
  name: text("name").primaryKey(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const propertyBuildings = sqliteTable(
  "property_buildings",
  {
    id: text("id").primaryKey(),
    propertyType: text("property_type").notNull(),
    buildingName: text("building_name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    uniqueIndex("idx_property_buildings_unique").on(
      table.propertyType,
      table.buildingName,
    ),
  ],
);

export const authAttempts = sqliteTable("auth_attempts", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull().default(0),
  blockedUntil: integer("blocked_until").notNull().default(0),
  updatedAt: integer("updated_at").notNull().default(0),
});

export const trashRecords = sqliteTable("trash_records", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  title: text("title").notNull(),
  subtitle: text("subtitle").notNull().default(""),
  searchText: text("search_text").notNull().default(""),
  snapshot: text("snapshot").notNull(),
  deletedAt: text("deleted_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("trash_records_entity_type", sql`${table.entityType} IN ('work', 'customer', 'followup')`),
  uniqueIndex("idx_trash_records_entity").on(table.entityType, table.entityId),
  index("idx_trash_records_deleted").on(table.deletedAt, table.id),
]);

export const appRuntimeState = sqliteTable("app_runtime_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const followUps = sqliteTable(
  "follow_ups",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    dueDate: text("due_date"),
    customerId: text("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    listingKey: text("listing_key"),
    completedAt: text("completed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "follow_ups_title_length",
      sql`length(trim(${table.title})) BETWEEN 1 AND 200`,
    ),
    check("follow_ups_notes_length", sql`length(${table.notes}) <= 5000`),
    index("idx_follow_ups_completed_due").on(table.completedAt, table.dueDate),
    index("idx_follow_ups_customer").on(table.customerId),
  ],
);
