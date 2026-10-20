CREATE TABLE `deck_doctor_prefs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`deck_ref` text NOT NULL,
	`oracle_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deck_doctor_prefs_unique` ON `deck_doctor_prefs` (`user_id`,`deck_ref`,`oracle_id`,`kind`);