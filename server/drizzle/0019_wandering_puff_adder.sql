ALTER TABLE `game_results` ADD `starting_seat` integer;--> statement-breakpoint
ALTER TABLE `game_results` ADD `first_player_method` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `first_player` text DEFAULT 'roll' NOT NULL;