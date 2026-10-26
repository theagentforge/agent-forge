CREATE TABLE `review_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`study` text NOT NULL,
	`seed` text NOT NULL,
	`config` text NOT NULL,
	`drawn_by` text NOT NULL,
	`drawn_at` integer NOT NULL,
	FOREIGN KEY (`drawn_by`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_samples_study_unique` ON `review_samples` (`study`);
--> statement-breakpoint
CREATE TABLE `review_items` (
	`sample_id` text NOT NULL,
	`item_id` text NOT NULL,
	`cell` text NOT NULL,
	`sub` text NOT NULL,
	`rank` integer NOT NULL,
	`position` integer,
	`status` text NOT NULL,
	`replaced_by` text,
	`truth` text NOT NULL,
	FOREIGN KEY (`sample_id`) REFERENCES `review_samples`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_items_pk` ON `review_items` (`sample_id`,`item_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_items_position` ON `review_items` (`sample_id`,`position`);
--> statement-breakpoint
CREATE INDEX `review_items_cell` ON `review_items` (`sample_id`,`cell`,`rank`);
--> statement-breakpoint
CREATE TABLE `review_labels` (
	`sample_id` text NOT NULL,
	`item_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`answer` text NOT NULL,
	`traps` text,
	`rule_marks` text,
	`note` text,
	`saw_replay` integer DEFAULT false NOT NULL,
	`revealed_at` integer,
	`seconds` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`sample_id`) REFERENCES `review_samples`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `humans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_labels_one_each` ON `review_labels` (`sample_id`,`item_id`,`reviewer_id`);
--> statement-breakpoint
CREATE INDEX `review_labels_reviewer` ON `review_labels` (`sample_id`,`reviewer_id`);
