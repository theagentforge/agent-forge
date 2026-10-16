CREATE TABLE `arena_fixtures` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`event_id` text NOT NULL,
	`task` text NOT NULL,
	`model_a` text NOT NULL,
	`model_b` text NOT NULL,
	`premiere_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `arena_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arena_fixtures_day_unique` ON `arena_fixtures` (`day`);--> statement-breakpoint
CREATE TABLE `arena_pick_totals` (
	`fixture_id` text NOT NULL,
	`option` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `arena_fixtures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arena_pick_totals_fixture_option` ON `arena_pick_totals` (`fixture_id`,`option`);--> statement-breakpoint
CREATE TABLE `arena_votes` (
	`week` text NOT NULL,
	`kind` text NOT NULL,
	`option` text NOT NULL,
	`human_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arena_votes_one_each` ON `arena_votes` (`week`,`kind`,`human_id`);