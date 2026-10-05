-- Folder listings page through children in (is_folder, name, id) order; this lets each page seek straight
-- to its cursor instead of rescanning the whole folder (see listPage in src/worker/lib/access.ts).
-- Numbered 0006 because 0004/0005 (Google sync) are already applied in production from another branch.
CREATE INDEX `files_list_idx` ON `files` (`parent_id`, `is_folder`, `name` COLLATE NOCASE, `id`);
