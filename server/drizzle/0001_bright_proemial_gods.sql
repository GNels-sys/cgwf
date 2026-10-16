CREATE TABLE `deck_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`deck_id` text NOT NULL,
	`card_id` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`board` text DEFAULT 'main' NOT NULL,
	`category` text,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`deck_id`) REFERENCES `decks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deck_cards_deck_idx` ON `deck_cards` (`deck_id`);--> statement-breakpoint
CREATE INDEX `deck_cards_card_idx` ON `deck_cards` (`card_id`);--> statement-breakpoint
CREATE TABLE `decks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`format` text DEFAULT 'commander' NOT NULL,
	`source_text` text,
	`source_url` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `decks_user_idx` ON `decks` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`avatar` text NOT NULL,
	`color` text NOT NULL,
	`device_token_hash` text NOT NULL,
	`email` text,
	`password_hash` text,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_device_token_idx` ON `users` (`device_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);