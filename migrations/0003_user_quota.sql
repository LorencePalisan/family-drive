-- Per-person storage limit in bytes, set by the owner on the Family page. NULL means the default (STORAGE_QUOTA_BYTES).
ALTER TABLE `users` ADD `storage_quota` integer;
