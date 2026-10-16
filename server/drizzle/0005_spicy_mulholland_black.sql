DROP INDEX `users_device_token_idx`;--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `device_token_hash`;