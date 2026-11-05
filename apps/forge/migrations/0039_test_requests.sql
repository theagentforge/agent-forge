CREATE TABLE `test_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`registry` text NOT NULL,
	`package` text NOT NULL,
	`version` text NOT NULL,
	`fingerprint` text NOT NULL,
	`repo_owner` text,
	`repo_name` text,
	`status` text NOT NULL,
	`channel` text NOT NULL,
	`requester_human_id` text,
	`claimed_by_human_id` text,
	`claimed_at` integer,
	`ip_day` text NOT NULL,
	`day` text NOT NULL,
	`requested_at` integer NOT NULL,
	`completed_at` integer,
	`outcome` text,
	`result` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_requests_server` ON `test_requests` (`registry`,`package`,`version`);--> statement-breakpoint
CREATE INDEX `test_requests_queue` ON `test_requests` (`status`,`requested_at`);--> statement-breakpoint
CREATE INDEX `test_requests_day` ON `test_requests` (`day`);--> statement-breakpoint
CREATE INDEX `test_requests_ip_day` ON `test_requests` (`ip_day`);