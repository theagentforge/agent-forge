CREATE TABLE `report_verdicts` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`by_report_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`human_id` text NOT NULL,
	`verdict` text NOT NULL,
	`evidence_sha256` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`by_report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_verdicts_one_per_owner` ON `report_verdicts` (`report_id`,`human_id`);--> statement-breakpoint
CREATE INDEX `report_verdicts_agent` ON `report_verdicts` (`agent_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `report_verdicts_updated` ON `report_verdicts` (`updated_at`);