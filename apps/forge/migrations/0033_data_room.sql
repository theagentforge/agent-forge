CREATE TABLE `data_room_access` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`at` integer NOT NULL,
	`event` text NOT NULL,
	`detail` text,
	`viewer` text,
	`country` text,
	FOREIGN KEY (`link_id`) REFERENCES `data_room_links`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `data_room_access_link` ON `data_room_access` (`link_id`,`at`);--> statement-breakpoint
CREATE TABLE `data_room_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`label` text NOT NULL,
	`nda_version` text NOT NULL,
	`include_export` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_by` text,
	`confirmed_at` integer,
	`confirmed_nda_version` text,
	`confirmed_org` text,
	`admin_note` text,
	`note_updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `data_room_links_token_hash_unique` ON `data_room_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `data_room_links_created` ON `data_room_links` (`created_at`);