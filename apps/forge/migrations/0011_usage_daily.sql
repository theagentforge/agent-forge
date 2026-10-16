CREATE TABLE `usage_daily` (
	`day` text NOT NULL,
	`key` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_daily_day_key` ON `usage_daily` (`day`,`key`);