-- One-way Google Drive → Family Drive sync.

-- A Google Drive folder someone chose to sync, and the Family Drive folder it is copied into.
-- The n_* / bytes_done / folders_pending counters are kept up to date as items change (and recounted daily),
-- so showing progress never has to count every item (D1 bills rows read).
CREATE TABLE `gsync_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`google_folder_id` text NOT NULL,
	`name` text NOT NULL,
	`dest_folder_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL, -- active | paused | error
	`status_message` text,
	`first_sync_done_at` integer,
	`n_pending` integer DEFAULT 0 NOT NULL, -- files
	`n_done` integer DEFAULT 0 NOT NULL,
	`n_skipped` integer DEFAULT 0 NOT NULL,
	`n_error` integer DEFAULT 0 NOT NULL, -- files and folders
	`bytes_done` integer DEFAULT 0 NOT NULL,
	`folders_pending` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `gsync_sources_user_folder_idx` ON `gsync_sources` (`user_id`, `google_folder_id`);

-- Per person: the Drive Changes API cursor, a cached access token (so idle runs don't refresh it every minute),
-- and a lease so overlapping runs don't process the same person twice.
CREATE TABLE `gsync_users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`changes_page_token` text,
	`changes_checked_at` integer DEFAULT 0 NOT NULL,
	`access_token_enc` text,
	`access_token_expires` integer DEFAULT 0 NOT NULL,
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
-- One index serves "next pending folders/files of this source" without scanning, and the daily recount.
CREATE INDEX `gsync_items_work_idx` ON `gsync_items` (`source_id`, `state`, `kind`, `retry_at`);
CREATE INDEX `gsync_items_mpu_idx` ON `gsync_items` (`source_id`) WHERE `mpu_id` IS NOT NULL;

-- Estimated D1 rows written by sync per UTC day, so a big first copy can't use up the whole app's daily write allowance.
CREATE TABLE `gsync_daily` (
	`day` text PRIMARY KEY NOT NULL,
	`writes` integer DEFAULT 0 NOT NULL
);

-- "Was this Google file made by our Open with Google?" is checked for every synced file.
CREATE INDEX `google_links_google_file_idx` ON `google_links` (`google_file_id`);
