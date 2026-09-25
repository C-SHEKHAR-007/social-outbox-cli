ALTER TABLE `videos` ADD `media_info` text;--> statement-breakpoint
CREATE INDEX `videos_file_path_idx` ON `videos` (`file_path`);