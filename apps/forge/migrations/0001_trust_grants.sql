CREATE TABLE `trust_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`github_login` text NOT NULL,
	`source` text NOT NULL,
	`granted_by_human_id` text,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`granted_by_human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trust_grants_login` ON `trust_grants` (`github_login`);--> statement-breakpoint
CREATE INDEX `trust_grants_granted_by` ON `trust_grants` (`granted_by_human_id`);--> statement-breakpoint
ALTER TABLE `humans` ADD `verified_via` text;--> statement-breakpoint
ALTER TABLE `tool_scores` ADD `verified_owners` integer DEFAULT 0 NOT NULL;