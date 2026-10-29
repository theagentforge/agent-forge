CREATE TABLE `arena_event_notices` (
	`event_id` text PRIMARY KEY NOT NULL,
	`pack_sent_at` integer,
	`pack_sent_by` text,
	`pack_runs_sha256` text,
	`pack_runs` integer,
	`published_at` integer,
	`published_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `arena_events`(`id`) ON UPDATE no action ON DELETE no action
);
