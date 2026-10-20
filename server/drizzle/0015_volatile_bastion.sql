CREATE TABLE `decision_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` text NOT NULL,
	`seat` integer NOT NULL,
	`user_id` text NOT NULL,
	`seq` integer NOT NULL,
	`turn` integer,
	`prompt_kind` text NOT NULL,
	`created_at` text NOT NULL,
	`data` blob NOT NULL
);
--> statement-breakpoint
CREATE INDEX `decision_snapshots_room_user_idx` ON `decision_snapshots` (`room_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `decision_snapshots_created_idx` ON `decision_snapshots` (`created_at`);