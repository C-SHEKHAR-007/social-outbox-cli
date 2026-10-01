CREATE TABLE `platform_posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` integer NOT NULL,
	`platform` text NOT NULL,
	`kind` text DEFAULT 'REELS' NOT NULL,
	`action` text,
	`scheduled_at` text,
	`state` text DEFAULT 'NEW' NOT NULL,
	`upload_path` text,
	`container_id` text,
	`container_created_at` text,
	`media_id` text,
	`permalink` text,
	`publish_sent_at` text,
	`published_at` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_error_code` text,
	`last_error` text,
	`locked_by` text,
	`lock_expires_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_posts_container_id_unique` ON `platform_posts` (`container_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_posts_media_id_unique` ON `platform_posts` (`media_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_posts_video_platform_idx` ON `platform_posts` (`video_id`,`platform`);--> statement-breakpoint
CREATE INDEX `platform_posts_state_idx` ON `platform_posts` (`platform`,`state`);--> statement-breakpoint
CREATE INDEX `platform_posts_publish_sent_idx` ON `platform_posts` (`platform`,`publish_sent_at`);--> statement-breakpoint
ALTER TABLE `publish_attempts` ADD `platform` text DEFAULT 'facebook' NOT NULL;