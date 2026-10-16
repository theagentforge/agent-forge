CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`handle` text NOT NULL,
	`framework` text NOT NULL,
	`oauth_client_id` text NOT NULL,
	`public_key` text,
	`status` text DEFAULT 'active' NOT NULL,
	`scout_points` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_handle_unique` ON `agents` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_human_client` ON `agents` (`human_id`,`oauth_client_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_created` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `disputes` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text,
	`report_id` text,
	`opened_by_human_id` text,
	`reason` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`resolved_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opened_by_human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `humans` (
	`id` text PRIMARY KEY NOT NULL,
	`github_id` integer NOT NULL,
	`github_login` text NOT NULL,
	`github_created_at` integer NOT NULL,
	`tier` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `humans_github_id_unique` ON `humans` (`github_id`);--> statement-breakpoint
CREATE TABLE `public_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`source` text NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `public_signals_tool` ON `public_signals` (`tool_id`);--> statement-breakpoint
CREATE TABLE `publisher_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`human_id` text NOT NULL,
	`method` text NOT NULL,
	`verified_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `replies` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`human_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`human_id` text NOT NULL,
	`tool_version_id` text NOT NULL,
	`task_category` text NOT NULL,
	`framework` text NOT NULL,
	`outcome` text NOT NULL,
	`issues` text NOT NULL,
	`note` text,
	`moderation_state` text NOT NULL,
	`server_signature` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tool_version_id`) REFERENCES `tool_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reports_tool_version` ON `reports` (`tool_version_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `reports_human` ON `reports` (`human_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `reports_agent` ON `reports` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `status_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_version_id` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`reason` text NOT NULL,
	`evidence_ref` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`tool_version_id`) REFERENCES `tool_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `status_events_tool_version` ON `status_events` (`tool_version_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tool_scores` (
	`tool_version_id` text PRIMARY KEY NOT NULL,
	`distinct_owners` integer NOT NULL,
	`success_score` integer,
	`outcome_breakdown` text NOT NULL,
	`security_status` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tool_version_id`) REFERENCES `tool_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tool_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`tool_id` text NOT NULL,
	`version` text NOT NULL,
	`fingerprint` text NOT NULL,
	`advisory_match` integer DEFAULT false NOT NULL,
	`confirmed_malicious` integer DEFAULT false NOT NULL,
	`first_seen_at` integer NOT NULL,
	FOREIGN KEY (`tool_id`) REFERENCES `tools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_versions_tool_fingerprint` ON `tool_versions` (`tool_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `tool_versions_fp` ON `tool_versions` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `tools` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`canonical_id` text NOT NULL,
	`source_url` text,
	`registry_refs` text,
	`publisher_github` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tools_canonical_id_unique` ON `tools` (`canonical_id`);