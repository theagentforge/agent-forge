CREATE TABLE `owner_review_requests` (
	`human_id` text PRIMARY KEY NOT NULL,
	`requested_at` integer NOT NULL,
	`decision` text,
	`decided_at` integer,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pending_claims` (
	`gauntlet_id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`agent_id` text,
	`season` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pending_claims_human` ON `pending_claims` (`human_id`);--> statement-breakpoint
ALTER TABLE `humans` ADD `first_from` text;--> statement-breakpoint
ALTER TABLE `humans` ADD `owner_since` integer;--> statement-breakpoint
ALTER TABLE `humans` ADD `owner_number` integer;--> statement-breakpoint
ALTER TABLE `humans` ADD `founding_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `humans_owner_number_unique` ON `humans` (`owner_number`);--> statement-breakpoint
-- ADR 0073: people who were already owners before this change get their "owner since" date (their first active agent),
-- so they are never counted as new owners (owner:new:<from>) and are numbered first, in that order. Numbers are given by
-- the Worker (services/owners.ts syncOwners), which knows the founder accounts; this statement only sets dates.
UPDATE `humans` SET `owner_since` = (SELECT min(a.`created_at`) FROM `agents` a WHERE a.`human_id` = `humans`.`id` AND a.`status` = 'active') WHERE `tier` = 'verified' AND `is_house` = 0 AND `owner_since` IS NULL AND EXISTS (SELECT 1 FROM `agents` a WHERE a.`human_id` = `humans`.`id` AND a.`status` = 'active');
