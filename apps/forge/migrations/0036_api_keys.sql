CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`hash_v` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE INDEX `api_keys_human` ON `api_keys` (`human_id`);--> statement-breakpoint
CREATE TABLE `api_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`human_id` text NOT NULL,
	`plan` text NOT NULL,
	`provider` text NOT NULL,
	`billing_interval` text DEFAULT 'month' NOT NULL,
	`price_cents` integer,
	`external_customer_id` text,
	`external_subscription_id` text,
	`status` text NOT NULL,
	`current_period_start` integer,
	`current_period_end` integer,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`overage_enabled` integer DEFAULT false NOT NULL,
	`source_updated_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`human_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_subscriptions_external_subscription_id_unique` ON `api_subscriptions` (`external_subscription_id`);--> statement-breakpoint
CREATE INDEX `api_subscriptions_human` ON `api_subscriptions` (`human_id`);--> statement-breakpoint
CREATE TABLE `api_usage_daily` (
	`key_id` text NOT NULL,
	`human_id` text NOT NULL,
	`day` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	`n_429` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`key_id`, `day`),
	FOREIGN KEY (`key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `api_usage_daily_human_day` ON `api_usage_daily` (`human_id`,`day`);--> statement-breakpoint
CREATE TABLE `pilot_revenue` (
	`id` text PRIMARY KEY NOT NULL,
	`customer` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`received_on` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);
