CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`oracle_id` text,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`set` text NOT NULL,
	`set_name` text NOT NULL,
	`collector_number` text NOT NULL,
	`released_at` text NOT NULL,
	`rarity` text NOT NULL,
	`layout` text NOT NULL,
	`mana_cost` text DEFAULT '' NOT NULL,
	`cmc` real DEFAULT 0 NOT NULL,
	`type_line` text DEFAULT '' NOT NULL,
	`oracle_text` text DEFAULT '' NOT NULL,
	`power` text,
	`toughness` text,
	`loyalty` text,
	`defense` text,
	`colors` text NOT NULL,
	`color_identity` text NOT NULL,
	`keywords` text NOT NULL,
	`legalities` text NOT NULL,
	`faces` text NOT NULL,
	`image_front` text,
	`image_back` text,
	`image_status` text DEFAULT '' NOT NULL,
	`is_token` integer DEFAULT false NOT NULL,
	`is_promo` integer DEFAULT false NOT NULL,
	`is_digital` integer DEFAULT false NOT NULL,
	`in_booster` integer DEFAULT false NOT NULL,
	`artist` text,
	`scryfall_uri` text DEFAULT '' NOT NULL,
	`seen_run` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cards_normalized_name_idx` ON `cards` (`normalized_name`);--> statement-breakpoint
CREATE INDEX `cards_oracle_id_idx` ON `cards` (`oracle_id`);--> statement-breakpoint
CREATE INDEX `cards_set_number_idx` ON `cards` (`set`,`collector_number`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
