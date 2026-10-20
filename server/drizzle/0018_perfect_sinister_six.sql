CREATE TABLE `doctor_ai_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`deck_ref` text NOT NULL,
	`deck_name` text NOT NULL,
	`deck_version` text NOT NULL,
	`target_bracket` integer NOT NULL,
	`allow_higher` integer DEFAULT false NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`invalid_submissions` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`served_by` text,
	`result` text,
	`error` text,
	`started_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `doctor_ai_runs_deck_idx` ON `doctor_ai_runs` (`deck_ref`,`deck_version`);--> statement-breakpoint
CREATE INDEX `doctor_ai_runs_started_idx` ON `doctor_ai_runs` (`started_at`);