CREATE TABLE `game_result_seats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`seat` integer NOT NULL,
	`user_id` text,
	`is_bot` integer DEFAULT false NOT NULL,
	`deck_ref` text,
	`deck_owner_id` text,
	`deck_name` text NOT NULL,
	`commanders` text NOT NULL,
	`deck_bracket` integer,
	`place` integer,
	`won` integer DEFAULT false NOT NULL,
	`conceded` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `game_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `game_result_seats_game_idx` ON `game_result_seats` (`game_id`);--> statement-breakpoint
CREATE INDEX `game_result_seats_deck_idx` ON `game_result_seats` (`deck_ref`);--> statement-breakpoint
CREATE TABLE `game_results` (
	`id` text PRIMARY KEY NOT NULL,
	`room_code` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`table_bracket` integer,
	`player_count` integer NOT NULL,
	`test` integer DEFAULT false NOT NULL,
	`counted` integer DEFAULT false NOT NULL,
	`end_reason` text,
	`detail` text,
	`turns` integer
);
--> statement-breakpoint
CREATE INDEX `game_results_counted_idx` ON `game_results` (`counted`);--> statement-breakpoint
ALTER TABLE `rooms` ADD `test_game` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `table_bracket` integer;--> statement-breakpoint
-- Owner, 2026-10-19: every game played before deck statistics existed is a test game and never counted.
UPDATE `rooms` SET `test_game` = 1;--> statement-breakpoint
INSERT INTO `game_results` (`id`, `room_code`, `started_at`, `ended_at`, `table_bracket`, `player_count`, `test`, `counted`, `end_reason`, `detail`, `turns`)
SELECT r.`id`, r.`code`, r.`created_at`, CASE WHEN r.`status` = 'ended' THEN r.`updated_at` ELSE NULL END, NULL,
  (SELECT count(*) FROM `room_members` m WHERE m.`room_id` = r.`id` AND m.`role` = 'player'), 1, 0, NULL,
  'backfilled: played before deck statistics (test game)', NULL
FROM `rooms` r WHERE r.`status` != 'lobby';
