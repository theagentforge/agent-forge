CREATE TABLE `skill_scans` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`name` text,
	`source_url` text,
	`verdict` text NOT NULL,
	`findings` text NOT NULL,
	`counts` text NOT NULL,
	`rules_version` text NOT NULL,
	`bytes` integer NOT NULL,
	`public` integer DEFAULT false NOT NULL,
	`scans` integer DEFAULT 1 NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `skill_scans_verdict_seen` ON `skill_scans` (`verdict`,`last_seen`);--> statement-breakpoint
CREATE INDEX `skill_scans_source` ON `skill_scans` (`source_url`);