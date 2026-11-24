CREATE TABLE `drift_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`poll_id` integer NOT NULL,
	`tool` text NOT NULL,
	`observed_at` integer NOT NULL,
	`previous_at` integer,
	`change_class` text NOT NULL,
	`description_changed` integer NOT NULL,
	`schema_changed` integer NOT NULL,
	`output_schema_changed` integer NOT NULL,
	`before_raw` text,
	`after_raw` text,
	`before_normalised` text,
	`after_normalised` text,
	`before_contract` text,
	`after_contract` text,
	`before_text` text,
	`after_text` text,
	`before_snapshot` text,
	`after_snapshot` text NOT NULL,
	`registry_version_before` text,
	`registry_version_after` text,
	`reported_version_before` text,
	`reported_version_after` text,
	`same_version` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `drift_events_server_at` ON `drift_events` (`server_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `drift_events_at` ON `drift_events` (`observed_at`);--> statement-breakpoint
CREATE INDEX `drift_events_class` ON `drift_events` (`change_class`);--> statement-breakpoint
CREATE TABLE `drift_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `drift_optouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`added_at` integer NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drift_optouts_kind_value` ON `drift_optouts` (`kind`,`value`);--> statement-breakpoint
CREATE TABLE `drift_polls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`at` integer NOT NULL,
	`status` text NOT NULL,
	`error_class` text,
	`http_status` integer,
	`snapshot` text,
	`tools_count` integer,
	`registry_version` text,
	`reported_version` text,
	`protocol_version` text,
	`baseline` integer DEFAULT false NOT NULL,
	`changes` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer
);
--> statement-breakpoint
CREATE INDEX `drift_polls_server_at` ON `drift_polls` (`server_id`,`at`);--> statement-breakpoint
CREATE INDEX `drift_polls_at` ON `drift_polls` (`at`);--> statement-breakpoint
CREATE TABLE `drift_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`registry_name` text NOT NULL,
	`remote_url` text NOT NULL,
	`host` text NOT NULL,
	`transport` text NOT NULL,
	`registry_version` text,
	`registry_status` text,
	`listed` integer DEFAULT true NOT NULL,
	`needs_config` text,
	`first_listed_at` integer NOT NULL,
	`last_listed_at` integer NOT NULL,
	`next_poll_at` integer NOT NULL,
	`last_poll_at` integer,
	`last_ok_at` integer,
	`last_status` text,
	`last_error_class` text,
	`last_http_status` integer,
	`consecutive_errors` integer DEFAULT 0 NOT NULL,
	`polls_total` integer DEFAULT 0 NOT NULL,
	`polls_ok` integer DEFAULT 0 NOT NULL,
	`first_observed_at` integer,
	`ok_registry_version` text,
	`ok_reported_version` text,
	`ok_snapshot` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drift_servers_name_url` ON `drift_servers` (`registry_name`,`remote_url`);--> statement-breakpoint
CREATE INDEX `drift_servers_due` ON `drift_servers` (`listed`,`next_poll_at`);--> statement-breakpoint
CREATE INDEX `drift_servers_url` ON `drift_servers` (`remote_url`);--> statement-breakpoint
CREATE INDEX `drift_servers_host` ON `drift_servers` (`host`);--> statement-breakpoint
CREATE TABLE `drift_snapshots` (
	`sha256` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`tools_count` integer NOT NULL,
	`bytes` integer NOT NULL,
	`first_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `drift_tool_state` (
	`server_id` text NOT NULL,
	`tool` text NOT NULL,
	`raw_digest` text NOT NULL,
	`normalised_digest` text NOT NULL,
	`contract_digest` text NOT NULL,
	`description_digest` text NOT NULL,
	`schema_digest` text NOT NULL,
	`output_digest` text NOT NULL,
	`text` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `tool`)
);
--> statement-breakpoint
CREATE TRIGGER `drift_events_no_update` BEFORE UPDATE ON `drift_events` BEGIN SELECT RAISE(ABORT, 'drift_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `drift_events_no_delete` BEFORE DELETE ON `drift_events` BEGIN SELECT RAISE(ABORT, 'drift_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `drift_polls_no_update` BEFORE UPDATE ON `drift_polls` BEGIN SELECT RAISE(ABORT, 'drift_polls is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `drift_polls_no_delete` BEFORE DELETE ON `drift_polls` BEGIN SELECT RAISE(ABORT, 'drift_polls is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `drift_snapshots_no_update` BEFORE UPDATE ON `drift_snapshots` BEGIN SELECT RAISE(ABORT, 'drift_snapshots is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `drift_snapshots_no_delete` BEFORE DELETE ON `drift_snapshots` BEGIN SELECT RAISE(ABORT, 'drift_snapshots is append-only'); END;
