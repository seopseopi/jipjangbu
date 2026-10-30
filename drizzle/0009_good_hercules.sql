CREATE TABLE `structure_plan_processing` (
	`revision_id` text PRIMARY KEY NOT NULL,
	`processing_json` text NOT NULL,
	`row_version` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `structure_plan_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "structure_processing_json" CHECK(json_valid("structure_plan_processing"."processing_json"))
);
