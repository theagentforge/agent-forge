ALTER TABLE `reports` ADD `held` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `strain_source` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `strain_attempts` integer;--> statement-breakpoint
ALTER TABLE `reports` ADD `strain_tool_errors` integer;--> statement-breakpoint
ALTER TABLE `reports` ADD `strain_retries` integer;--> statement-breakpoint
ALTER TABLE `reports` ADD `strain_loop_detected` integer;--> statement-breakpoint
ALTER TABLE `reports` ADD `strain_context_reset` integer;--> statement-breakpoint
ALTER TABLE `reports` ADD `strain_outcome_after_reset` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `strain_escalated` integer;--> statement-breakpoint
ALTER TABLE `tool_scores` ADD `loop_rate` real;--> statement-breakpoint
ALTER TABLE `tool_scores` ADD `recovers_after_reset_rate` real;--> statement-breakpoint
ALTER TABLE `tool_scores` ADD `strain_reports` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tool_scores` ADD `strain_hook_reports` integer DEFAULT 0 NOT NULL;