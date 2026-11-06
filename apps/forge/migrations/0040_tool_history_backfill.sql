CREATE TABLE `tool_definition_drift` (
	`tool_id` text NOT NULL,
	`seq` integer NOT NULL,
	`server` text NOT NULL,
	`from_version` text NOT NULL,
	`to_version` text NOT NULL,
	`from_sha256` text NOT NULL,
	`to_sha256` text NOT NULL,
	`from_published_at` integer,
	`to_published_at` integer,
	`change_class` text NOT NULL,
	`tools_added` integer NOT NULL,
	`tools_removed` integer NOT NULL,
	`descriptions_changed` integer NOT NULL,
	`schemas_changed` integer NOT NULL,
	`major_bump` integer NOT NULL,
	`zero_major` integer NOT NULL,
	`same_version` integer NOT NULL,
	`untested_between` integer NOT NULL,
	`new_text_rules` text NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`tool_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `tool_drift_state` (
	`tool_id` text PRIMARY KEY NOT NULL,
	`print` text NOT NULL,
	`computed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tool_history_queue` (
	`server` text NOT NULL,
	`version` text NOT NULL,
	`published_at` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`outcome` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`offered_at` integer,
	`observed_at` integer,
	`tools_count` integer,
	`description_sha256` text,
	`enqueued_at` integer NOT NULL,
	PRIMARY KEY(`server`, `version`)
);
--> statement-breakpoint
CREATE INDEX `tool_history_queue_status` ON `tool_history_queue` (`status`,`attempts`);--> statement-breakpoint
CREATE TABLE `tool_history_servers` (
	`server` text PRIMARY KEY NOT NULL,
	`registry` text NOT NULL,
	`package` text NOT NULL,
	`tool_id` text,
	`source` text NOT NULL,
	`rank` integer NOT NULL,
	`status` text,
	`enumerated_at` integer,
	`versions_listed` integer,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `tool_description_history` ADD `origin` text DEFAULT 'nightly' NOT NULL;--> statement-breakpoint
ALTER TABLE `tool_description_history` ADD `observed_at` integer;--> statement-breakpoint
UPDATE `tool_description_history` SET `origin` = 'carried' WHERE `carried` = 1;--> statement-breakpoint
UPDATE `tool_description_history` SET `observed_at` = `first_seen` WHERE `observed_at` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `tool_description_history_origin_key` ON `tool_description_history` (`tool_id`,`version`,`description_sha256`,`origin`);--> statement-breakpoint
DROP INDEX `tool_description_history_key`;