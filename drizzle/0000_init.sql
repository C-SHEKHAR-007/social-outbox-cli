CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `publish_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` integer NOT NULL,
	`step` text NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`ended_at` text,
	`outcome` text,
	`http_status` integer,
	`fb_error_code` integer,
	`fb_error_subcode` integer,
	`message` text,
	`fb_trace_id` text,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `publish_attempts_video_id_idx` ON `publish_attempts` (`video_id`);--> statement-breakpoint
CREATE TABLE `videos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_hash` text NOT NULL,
	`file_path` text NOT NULL,
	`filename` text NOT NULL,
	`file_size` integer NOT NULL,
	`file_mtime` integer NOT NULL,
	`duration_s` real,
	`width` integer,
	`height` integer,
	`fps` real,
	`video_codec` text,
	`audio_codec` text,
	`audio_sample_rate` integer,
	`audio_channels` integer,
	`container` text,
	`bitrate` integer,
	`spec_ok` integer,
	`spec_issues` text,
	`normalized_path` text,
	`transcript` text,
	`transcript_lang` text,
	`caption` text,
	`hashtags` text,
	`title` text,
	`caption_source` text,
	`ai_model` text,
	`generated_at` text,
	`is_ai_generated` integer DEFAULT false NOT NULL,
	`action` text,
	`scheduled_at` text,
	`state` text DEFAULT 'NEW' NOT NULL,
	`fb_video_id` text,
	`fb_post_id` text,
	`fb_permalink` text,
	`bytes_uploaded` integer DEFAULT 0 NOT NULL,
	`finish_sent_at` text,
	`published_at` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_error_code` text,
	`last_error` text,
	`locked_by` text,
	`lock_expires_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `videos_file_hash_unique` ON `videos` (`file_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `videos_fb_video_id_unique` ON `videos` (`fb_video_id`);--> statement-breakpoint
CREATE INDEX `videos_state_idx` ON `videos` (`state`);--> statement-breakpoint
CREATE INDEX `videos_scheduled_at_idx` ON `videos` (`scheduled_at`);--> statement-breakpoint
CREATE INDEX `videos_finish_sent_at_idx` ON `videos` (`finish_sent_at`);