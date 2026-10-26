CREATE TABLE `arena_panel` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`model_id` text NOT NULL,
	`pinned_model` text NOT NULL,
	`provider` text NOT NULL,
	`panel_version` text NOT NULL,
	`bouts` integer NOT NULL,
	`queued_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `arena_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arena_panel_event_id_unique` ON `arena_panel` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `arena_panel_version` ON `arena_panel` (`model_id`,`pinned_model`,`provider`,`panel_version`);--> statement-breakpoint
ALTER TABLE `arena_runs` ADD `held_out` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `arena_runs` ADD `model_version` text;