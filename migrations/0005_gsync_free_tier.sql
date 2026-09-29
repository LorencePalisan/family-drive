-- Keep Google Drive sync within Cloudflare's free limits (upgrades the tables from 0004).

-- Progress counters, kept up to date as items change (and recounted daily), so showing progress never counts every item.
ALTER TABLE `gsync_sources` ADD `n_pending` integer DEFAULT 0 NOT NULL; -- files
ALTER TABLE `gsync_sources` ADD `n_done` integer DEFAULT 0 NOT NULL;
ALTER TABLE `gsync_sources` ADD `n_skipped` integer DEFAULT 0 NOT NULL;
ALTER TABLE `gsync_sources` ADD `n_error` integer DEFAULT 0 NOT NULL; -- files and folders
ALTER TABLE `gsync_sources` ADD `bytes_done` integer DEFAULT 0 NOT NULL;
ALTER TABLE `gsync_sources` ADD `folders_pending` integer DEFAULT 0 NOT NULL;
ALTER TABLE `gsync_sources` DROP COLUMN `last_synced_at`; -- now gsync_users.changes_checked_at

-- A cached access token, so idle runs don't refresh it every minute.
ALTER TABLE `gsync_users` ADD `access_token_enc` text;
ALTER TABLE `gsync_users` ADD `access_token_expires` integer DEFAULT 0 NOT NULL;

-- One index serves "next pending folders/files of this source" without scanning, and the daily recount.
DROP INDEX `gsync_items_work_idx`;
DROP INDEX `gsync_items_source_idx`;
CREATE INDEX `gsync_items_work_idx` ON `gsync_items` (`source_id`, `state`, `kind`, `retry_at`);
CREATE INDEX `gsync_items_mpu_idx` ON `gsync_items` (`source_id`) WHERE `mpu_id` IS NOT NULL;

-- Estimated D1 rows written by sync per UTC day, so a big first copy can't use up the whole app's daily write allowance.
CREATE TABLE `gsync_daily` (
	`day` text PRIMARY KEY NOT NULL,
	`writes` integer DEFAULT 0 NOT NULL
);

-- "Was this Google file made by our Open with Google?" is checked for every synced file.
CREATE INDEX `google_links_google_file_idx` ON `google_links` (`google_file_id`);

-- Fill the counters for folders that were already syncing.
UPDATE `gsync_sources` SET
	`n_pending` = (SELECT COUNT(*) FROM `gsync_items` i WHERE i.`source_id` = `gsync_sources`.`id` AND i.`state` = 'pending' AND i.`kind` = 'file'),
	`n_done` = (SELECT COUNT(*) FROM `gsync_items` i WHERE i.`source_id` = `gsync_sources`.`id` AND i.`state` = 'done' AND i.`kind` = 'file'),
	`n_skipped` = (SELECT COUNT(*) FROM `gsync_items` i WHERE i.`source_id` = `gsync_sources`.`id` AND i.`state` = 'skipped' AND i.`kind` = 'file'),
	`n_error` = (SELECT COUNT(*) FROM `gsync_items` i WHERE i.`source_id` = `gsync_sources`.`id` AND i.`state` = 'error'),
	`folders_pending` = (SELECT COUNT(*) FROM `gsync_items` i WHERE i.`source_id` = `gsync_sources`.`id` AND i.`state` = 'pending' AND i.`kind` = 'folder'),
	`bytes_done` = (SELECT COALESCE(SUM(`size`), 0) FROM `gsync_items` i WHERE i.`source_id` = `gsync_sources`.`id` AND i.`state` = 'done' AND i.`kind` = 'file');
