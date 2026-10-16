CREATE TABLE `tool_aliases` (
	`alias` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reports_created` ON `reports` (`created_at`);