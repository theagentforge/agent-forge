CREATE TABLE `claim_checks` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`claim_id` text NOT NULL,
	`run_id` text NOT NULL,
	`trigger` text NOT NULL,
	`checked_at` integer NOT NULL,
	`fetched_url` text NOT NULL,
	`via` text NOT NULL,
	`http_status` integer,
	`response_sha256` text,
	`verdict` text NOT NULL,
	`reason` text NOT NULL,
	`quote` text,
	`quote_offset` integer,
	`observed_value` text,
	`observed_as_of` text,
	`checker` text NOT NULL,
	`prev_hash` text NOT NULL,
	`row_hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_checks_prev` ON `claim_checks` (`prev_hash`);--> statement-breakpoint
CREATE INDEX `claim_checks_claim` ON `claim_checks` (`claim_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`url` text NOT NULL,
	`anchor_kind` text NOT NULL,
	`anchor_path` text,
	`expected` text,
	`comparator` text,
	`tolerance` real,
	`counter` integer DEFAULT false NOT NULL,
	`author` text NOT NULL,
	`author_model` text,
	`appears_in` text NOT NULL,
	`made_at` integer NOT NULL,
	`retired_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claims_live` ON `claims` (`retired_at`);--> statement-breakpoint
CREATE TRIGGER `claim_checks_no_update` BEFORE UPDATE ON `claim_checks` BEGIN SELECT RAISE(ABORT, 'claim_checks is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `claim_checks_no_delete` BEFORE DELETE ON `claim_checks` BEGIN SELECT RAISE(ABORT, 'claim_checks is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `claims_no_edit` BEFORE UPDATE OF `id`, `text`, `url`, `anchor_kind`, `anchor_path`, `expected`, `comparator`, `tolerance`, `counter`, `author`, `author_model`, `appears_in`, `made_at`, `created_at` ON `claims` BEGIN SELECT RAISE(ABORT, 'claims are never edited: add a new claim and retire the old one'); END;
--> statement-breakpoint
CREATE TRIGGER `claims_no_unretire` BEFORE UPDATE OF `retired_at` ON `claims` WHEN OLD.`retired_at` IS NOT NULL BEGIN SELECT RAISE(ABORT, 'a retired claim stays retired'); END;
--> statement-breakpoint
CREATE TRIGGER `claims_no_delete` BEFORE DELETE ON `claims` BEGIN SELECT RAISE(ABORT, 'claims are never deleted: retire them'); END;
