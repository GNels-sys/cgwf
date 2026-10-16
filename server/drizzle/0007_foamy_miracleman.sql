CREATE TABLE `agent_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`room_id` text NOT NULL,
	`turn` integer NOT NULL,
	`step` text NOT NULL,
	`kind` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`outcome` text NOT NULL,
	`rationale` text DEFAULT '' NOT NULL,
	`tool_calls` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_decisions_run_idx` ON `agent_decisions` (`run_id`);--> statement-breakpoint
CREATE INDEX `agent_decisions_created_idx` ON `agent_decisions` (`created_at`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`seat` integer NOT NULL,
	`library_deck_id` text,
	`deck_name` text NOT NULL,
	`model` text NOT NULL,
	`mode` text DEFAULT 'live' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`decisions` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`stopped_reason` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_runs_room_idx` ON `agent_runs` (`room_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_started_idx` ON `agent_runs` (`started_at`);--> statement-breakpoint
ALTER TABLE `library_decks` ADD `primer_drafted_at` text;--> statement-breakpoint
ALTER TABLE `library_decks` ADD `primer_model` text;--> statement-breakpoint
ALTER TABLE `users` ADD `is_agent` integer DEFAULT false NOT NULL;