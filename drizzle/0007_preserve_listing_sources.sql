CREATE TABLE `listing_source_notes` (
	`identity_key` text PRIMARY KEY NOT NULL,
	`source_notes` text DEFAULT '' NOT NULL,
	`event_history` text DEFAULT '[]' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "listing_source_notes_event_history_array" CHECK(json_valid(event_history) AND json_type(event_history) = 'array')
);
--> statement-breakpoint
CREATE INDEX `idx_work_log_properties_source_log` ON `work_log_properties` (trim("source"),`work_log_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO listing_source_notes (identity_key, source_notes, event_history)
SELECT l.identity_key, l.source_notes, (SELECT json_group_array(json_object(
  'work_log_id', e.work_log_id, 'event_date', e.event_date, 'status', e.status, 'notes', e.notes))
  FROM listing_events e WHERE e.listing_key = l.identity_key)
FROM listings l WHERE l.source_notes <> '';
