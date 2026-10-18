CREATE TABLE `arena_gauntlet_bouts` (
	`id` text PRIMARY KEY NOT NULL,
	`gauntlet_id` text NOT NULL,
	`idx` integer NOT NULL,
	`task` text NOT NULL,
	`seed` integer NOT NULL,
	`calls` text NOT NULL,
	`status` text NOT NULL,
	`passed` integer,
	`result` text,
	`log` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`gauntlet_id`) REFERENCES `arena_gauntlets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `arena_gauntlet_bouts_idx` ON `arena_gauntlet_bouts` (`gauntlet_id`,`idx`);--> statement-breakpoint
CREATE TABLE `arena_gauntlets` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`card_from` text,
	`card` text,
	`current` integer DEFAULT 0 NOT NULL,
	`summary` text,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `arena_gauntlets_card_from` ON `arena_gauntlets` (`card_from`);--> statement-breakpoint
CREATE INDEX `arena_gauntlets_started` ON `arena_gauntlets` (`started_at`);