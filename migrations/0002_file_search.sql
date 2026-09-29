-- Full-text (substring) search over file names, so search reads only matching rows instead of every file.
-- Hand-written: drizzle-kit can't express FTS5 virtual tables or triggers.
-- The trigram tokenizer keeps "contains" semantics ("each" finds "beach.jpg") for queries of 3+ characters.
-- file_search_ids gives each file a stable integer rowid for the FTS table (files has a text primary key,
-- whose implicit rowid isn't guaranteed stable).

CREATE TABLE file_search_ids (
  rid INTEGER PRIMARY KEY,
  file_id TEXT NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE VIRTUAL TABLE files_fts USING fts5(name, tokenize = 'trigram');
--> statement-breakpoint
INSERT INTO file_search_ids (file_id) SELECT id FROM files;
--> statement-breakpoint
INSERT INTO files_fts (rowid, name) SELECT s.rid, f.name FROM file_search_ids s JOIN files f ON f.id = s.file_id;
--> statement-breakpoint
CREATE TRIGGER files_fts_insert AFTER INSERT ON files BEGIN
  INSERT INTO file_search_ids (file_id) VALUES (new.id);
  INSERT INTO files_fts (rowid, name) VALUES ((SELECT rid FROM file_search_ids WHERE file_id = new.id), new.name);
END;
--> statement-breakpoint
CREATE TRIGGER files_fts_rename AFTER UPDATE OF name ON files BEGIN
  UPDATE files_fts SET name = new.name WHERE rowid = (SELECT rid FROM file_search_ids WHERE file_id = new.id);
END;
--> statement-breakpoint
CREATE TRIGGER files_fts_delete AFTER DELETE ON files BEGIN
  DELETE FROM files_fts WHERE rowid = (SELECT rid FROM file_search_ids WHERE file_id = old.id);
  DELETE FROM file_search_ids WHERE file_id = old.id;
END;
