CREATE TABLE `file_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`size` integer NOT NULL,
	`mime` text,
	`source` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `file_versions_file_idx` ON `file_versions` (`file_id`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`is_folder` integer DEFAULT false NOT NULL,
	`mime` text,
	`size` integer DEFAULT 0 NOT NULL,
	`current_version_id` text,
	`thumb_key` text,
	`width` integer,
	`height` integer,
	`duration` integer,
	`trashed_at` integer,
	`trashed_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `files_parent_idx` ON `files` (`parent_id`);--> statement-breakpoint
CREATE INDEX `files_owner_idx` ON `files` (`owner_id`,`parent_id`);--> statement-breakpoint
CREATE INDEX `files_trashed_idx` ON `files` (`trashed_at`);--> statement-breakpoint
CREATE INDEX `files_name_idx` ON `files` (`name`);--> statement-breakpoint
CREATE TABLE `google_links` (
	`file_id` text NOT NULL,
	`user_id` text NOT NULL,
	`google_file_id` text NOT NULL,
	`google_mime` text NOT NULL,
	`web_view_link` text NOT NULL,
	`source_version_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`file_id`, `user_id`),
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `google_tokens` (
	`user_id` text PRIMARY KEY NOT NULL,
	`refresh_token_enc` text NOT NULL,
	`scopes` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`invited_by` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_hash_unique` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invites_email_idx` ON `invites` (`email`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`actor_id` text,
	`file_id` text,
	`payload` text,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `recents` (
	`user_id` text NOT NULL,
	`file_id` text NOT NULL,
	`action` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `file_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recents_user_at_idx` ON `recents` (`user_id`,`at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `share_links` (
	`token` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`expires_at` integer,
	`disabled_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_links_file_idx` ON `share_links` (`file_id`);--> statement-breakpoint
CREATE TABLE `shares` (
	`file_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`shared_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`file_id`, `user_id`),
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shares_user_idx` ON `shares` (`user_id`);--> statement-breakpoint
CREATE TABLE `stars` (
	`user_id` text NOT NULL,
	`file_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `file_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`r2_upload_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`file_id` text NOT NULL,
	`version_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`mime` text,
	`size` integer NOT NULL,
	`part_size` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_file_idx` ON `uploads` (`file_id`);--> statement-breakpoint
CREATE INDEX `uploads_status_idx` ON `uploads` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text,
	`role` text DEFAULT 'member' NOT NULL,
	`storage_used` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);