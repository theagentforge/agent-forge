CREATE TABLE `arena_pg_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`human_id` text NOT NULL,
	`task` text NOT NULL,
	`seed` integer NOT NULL,
	`calls` text NOT NULL,
	`status` text NOT NULL,
	`score` real,
	`passed` integer,
	`result` text,
	`log` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `arena_pg_agent` ON `arena_pg_attempts` (`agent_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `arena_ratings` (
	`subject` text PRIMARY KEY NOT NULL,
	`rating` real NOT NULL,
	`rd` real NOT NULL,
	`vol` real NOT NULL,
	`games` integer DEFAULT 0 NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
