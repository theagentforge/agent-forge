CREATE TABLE `check_sources` (
	`day` text NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`is_house` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `check_sources_day_source_kind` ON `check_sources` (`day`,`source`,`kind`);--> statement-breakpoint
CREATE TABLE `proof_snapshots` (
	`date` text NOT NULL,
	`metric` text NOT NULL,
	`external_value` real NOT NULL,
	`house_value` real NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proof_snapshots_date_metric` ON `proof_snapshots` (`date`,`metric`);--> statement-breakpoint
ALTER TABLE `humans` ADD `is_house` integer DEFAULT false NOT NULL;