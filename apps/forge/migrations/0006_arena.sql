CREATE TABLE `arena_events` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`season` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`twist` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arena_events_slug_unique` ON `arena_events` (`slug`);--> statement-breakpoint
CREATE TABLE `arena_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`model_id` text NOT NULL,
	`task` text NOT NULL,
	`seed` integer NOT NULL,
	`attempt_no` integer NOT NULL,
	`status` text NOT NULL,
	`retries` integer DEFAULT 0 NOT NULL,
	`void_reason` text,
	`passed` integer,
	`score` real,
	`cost` real,
	`cost_estimated` integer DEFAULT false NOT NULL,
	`tokens` integer,
	`provider` text,
	`result` text,
	`log` text,
	`signature` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `arena_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `arena_runs_status` ON `arena_runs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `arena_runs_event` ON `arena_runs` (`event_id`);--> statement-breakpoint
CREATE INDEX `arena_runs_model_task` ON `arena_runs` (`model_id`,`task`);