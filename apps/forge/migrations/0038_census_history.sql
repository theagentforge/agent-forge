CREATE TABLE `census_versions` (
	`version` text PRIMARY KEY NOT NULL,
	`published_at` integer NOT NULL,
	`files` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `house_results` (
	`family` text NOT NULL,
	`night` text NOT NULL,
	`server` text NOT NULL,
	`version` text,
	`outcome` text NOT NULL,
	`rank` integer,
	`downloads` integer,
	`tools` integer,
	`ms` integer,
	`slow` integer DEFAULT false NOT NULL,
	`probed_at` integer NOT NULL,
	`origin` text NOT NULL,
	PRIMARY KEY(`family`, `night`, `server`)
);
--> statement-breakpoint
CREATE TABLE `metric_snapshots` (
	`date` text NOT NULL,
	`metric` text NOT NULL,
	`family` text NOT NULL,
	`value` real NOT NULL,
	`unit` text NOT NULL,
	`kind` text NOT NULL,
	`method` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`date`, `metric`)
);
--> statement-breakpoint
CREATE TABLE `tool_description_history` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`server` text NOT NULL,
	`version` text NOT NULL,
	`description_sha256` text NOT NULL,
	`tools_count` integer NOT NULL,
	`descriptions_count` integer NOT NULL,
	`verdict` text NOT NULL,
	`counts` text NOT NULL,
	`findings` text NOT NULL,
	`rules_version` text NOT NULL,
	`tool_list` text NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`carried` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_description_history_key` ON `tool_description_history` (`tool_id`,`version`,`description_sha256`);--> statement-breakpoint
CREATE INDEX `tool_description_history_seen` ON `tool_description_history` (`last_seen`);--> statement-breakpoint
CREATE INDEX `tool_description_history_server` ON `tool_description_history` (`server`,`version`);--> statement-breakpoint
INSERT OR IGNORE INTO `tool_description_history` (`id`, `tool_id`, `server`, `version`, `description_sha256`, `tools_count`, `descriptions_count`, `verdict`, `counts`, `findings`, `rules_version`, `tool_list`, `first_seen`, `last_seen`, `carried`)
SELECT 'carried-' || ps.`id`, ps.`tool_id`, t.`canonical_id`, json_extract(ps.`payload`, '$.version'), substr(json_extract(ps.`payload`, '$.fingerprint'), 8),
  coalesce(json_extract(ps.`payload`, '$.tools_count'), 0),
  (SELECT count(*) FROM json_each(ps.`payload`, '$.tools') j WHERE length(json_extract(j.value, '$.description')) > 0),
  json_extract(ps.`payload`, '$.verdict'), json(json_extract(ps.`payload`, '$.counts')), json(json_extract(ps.`payload`, '$.findings')),
  json_extract(ps.`payload`, '$.rules_version'), json(json_extract(ps.`payload`, '$.tools')), ps.`fetched_at`, ps.`fetched_at`, 1
FROM `public_signals` ps JOIN `tools` t ON t.`id` = ps.`tool_id`
WHERE ps.`source` = 'house-tools' AND json_extract(ps.`payload`, '$.fingerprint') LIKE 'sha256:%';
