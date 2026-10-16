CREATE TABLE `tool_checks` (
	`tool_id` text NOT NULL,
	`day` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_checks_tool_day` ON `tool_checks` (`tool_id`,`day`);