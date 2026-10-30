CREATE TABLE `structure_plan_files` (
	`revision_id` text PRIMARY KEY NOT NULL,
	`storage_key` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `structure_plan_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "structure_file_type" CHECK("structure_plan_files"."mime_type" IN ('application/pdf','image/jpeg','image/png')),
	CONSTRAINT "structure_file_size" CHECK("structure_plan_files"."byte_size" BETWEEN 8 AND 33554432),
	CONSTRAINT "structure_file_hash" CHECK(length("structure_plan_files"."sha256")=64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `structure_plan_files_storage_key_unique` ON `structure_plan_files` (`storage_key`);