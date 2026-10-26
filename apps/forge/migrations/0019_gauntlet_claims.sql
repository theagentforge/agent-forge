CREATE TABLE `gauntlet_claims` (
	`gauntlet_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`human_id` text NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`claimed_at` integer NOT NULL,
	FOREIGN KEY (`gauntlet_id`) REFERENCES `arena_gauntlets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `gauntlet_claims_agent` ON `gauntlet_claims` (`agent_id`);--> statement-breakpoint
CREATE INDEX `gauntlet_claims_human` ON `gauntlet_claims` (`human_id`);--> statement-breakpoint
ALTER TABLE `arena_gauntlets` ADD `claim_key_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `arena_gauntlets_claim_key_hash_unique` ON `arena_gauntlets` (`claim_key_hash`);