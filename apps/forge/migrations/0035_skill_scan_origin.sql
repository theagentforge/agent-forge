ALTER TABLE `skill_scans` ADD `origin` text;--> statement-breakpoint
CREATE INDEX `skill_scans_origin` ON `skill_scans` (`origin`);