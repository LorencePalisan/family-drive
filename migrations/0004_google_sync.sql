-- One-way Google Drive → Family Drive sync.

-- A Google Drive folder someone chose to sync, and the Family Drive folder it is copied into.
CREATE TABLE `gsync_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`google_folder_id` text NOT NULL,
	`name` text NOT NULL,
	`dest_folder_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL, -- active | paused | error
	`status_message` text,
	`first_sync_done_at` integer,
	`last_synced_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `gsync_sources_user_folder_idx` ON `gsync_sources` (`user_id`, `google_folder_id`);

-- Per person: the Drive Changes API cursor, and a lease so overlapping cron runs don't process the same person twice.
CREATE TABLE `gsync_users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`changes_page_token` text,
	`changes_checked_at` integer DEFAULT 0 NOT NULL,
	`locked_until` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

-- Every Google folder/file inside a synced folder, and the Family Drive item it became.
CREATE TABLE `gsync_items` (
	`user_id` text NOT NULL,
	`google_id` text NOT NULL,
	`source_id` text NOT NULL,
	`kind` text NOT NULL, -- folder | file
	`name` text NOT NULL,
	`google_parent_id` text,
	`file_id` text, -- the Family Drive file/folder (not a foreign key: it can be purged, which means "removed here, don't re-add")
	`google_version` text, -- md5Checksum, or modifiedTime for Google Docs/Sheets/Slides
	`size` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL, -- pending | done | skipped | error
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer DEFAULT 0 NOT NULL,
	`page_token` text, -- folder listing continuation
	`mpu_id` text, -- large-file multipart upload resumed across runs
	`mpu_key` text,
	`mpu_version_id` text,
	`mpu_parts` text,
	`mpu_offset` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `google_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `gsync_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `gsync_items_work_idx` ON `gsync_items` (`user_id`, `state`, `retry_at`);
CREATE INDEX `gsync_items_source_idx` ON `gsync_items` (`source_id`, `state`);
