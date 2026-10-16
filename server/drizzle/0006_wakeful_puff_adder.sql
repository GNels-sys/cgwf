CREATE TABLE `combo_cache` (
	`list_hash` text PRIMARY KEY NOT NULL,
	`results` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `library_deck_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`library_deck_id` text NOT NULL,
	`card_id` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`board` text DEFAULT 'main' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`library_deck_id`) REFERENCES `library_decks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `library_deck_cards_deck_idx` ON `library_deck_cards` (`library_deck_id`);--> statement-breakpoint
CREATE TABLE `library_decks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`source_key` text,
	`set_code` text,
	`set_name` text,
	`release_date` text,
	`commanders` text NOT NULL,
	`bracket` integer DEFAULT 2 NOT NULL,
	`bracket_floor` integer,
	`bracket_suggested` integer,
	`tags` text NOT NULL,
	`primer` text DEFAULT '' NOT NULL,
	`agent_eligible` integer DEFAULT false NOT NULL,
	`analysis` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_decks_source_key_idx` ON `library_decks` (`source_key`);--> statement-breakpoint
CREATE INDEX `library_decks_bracket_idx` ON `library_decks` (`bracket`);