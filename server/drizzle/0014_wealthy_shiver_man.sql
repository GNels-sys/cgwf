ALTER TABLE `cards` ADD `set_type` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `frame` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `frame_effects` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `border_color` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `full_art` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `textless` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `promo_types` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `finishes` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `oversized` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `is_regular` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `treatment_count` integer DEFAULT 0 NOT NULL;