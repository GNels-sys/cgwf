ALTER TABLE `game_results` ADD `opening_hand` text;--> statement-breakpoint
ALTER TABLE `game_results` ADD `free_mulligans` integer;--> statement-breakpoint
ALTER TABLE `rooms` ADD `opening_hand` text DEFAULT 'draw7' NOT NULL;--> statement-breakpoint
ALTER TABLE `rooms` ADD `free_mulligans` integer DEFAULT 1 NOT NULL;