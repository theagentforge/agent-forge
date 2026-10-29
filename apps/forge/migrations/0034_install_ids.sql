CREATE TABLE `install_ids` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`client` text NOT NULL,
	`first_day` text NOT NULL,
	`last_day` text NOT NULL,
	`ours` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `install_ids_first_day` ON `install_ids` (`first_day`);--> statement-breakpoint
CREATE INDEX `install_ids_last_day` ON `install_ids` (`last_day`);