ALTER TABLE `videos` ADD `publish_target` text DEFAULT 'REEL' NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` ADD `target_source` text DEFAULT 'auto' NOT NULL;