ALTER TABLE `arena_gauntlets` ADD `mode` text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE `arena_gauntlets` ADD `sprint` text;--> statement-breakpoint
CREATE INDEX `arena_gauntlets_mode_status` ON `arena_gauntlets` (`mode`,`status`);