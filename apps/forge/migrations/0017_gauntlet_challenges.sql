ALTER TABLE `arena_gauntlets` ADD `challenge_of` text;--> statement-breakpoint
ALTER TABLE `arena_gauntlets` ADD `challenge` text;--> statement-breakpoint
CREATE INDEX `arena_gauntlets_challenge_of` ON `arena_gauntlets` (`challenge_of`);