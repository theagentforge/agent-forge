CREATE TABLE `gauntlet_season_entries` (
	`season_id` text NOT NULL,
	`gauntlet_id` text NOT NULL,
	`human_id` text NOT NULL,
	`entered_at` integer NOT NULL,
	FOREIGN KEY (`gauntlet_id`) REFERENCES `arena_gauntlets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gauntlet_season_entries_run` ON `gauntlet_season_entries` (`season_id`,`gauntlet_id`);--> statement-breakpoint
CREATE INDEX `gauntlet_season_entries_human` ON `gauntlet_season_entries` (`human_id`);--> statement-breakpoint
CREATE TABLE `gauntlet_season_snapshots` (
	`season_id` text NOT NULL,
	`week` integer NOT NULL,
	`as_of` integer NOT NULL,
	`taken_at` integer NOT NULL,
	`entries` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gauntlet_season_snapshots_week` ON `gauntlet_season_snapshots` (`season_id`,`week`);--> statement-breakpoint
CREATE TABLE `gauntlet_seasons` (
	`id` text PRIMARY KEY NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
