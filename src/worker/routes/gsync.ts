import { Hono } from "hono";
import type { AppEnv } from "../types";
import { fail } from "../types";
import { newId } from "../lib/crypto";
import { driveAccessToken, hasScope, DRIVE_READONLY_SCOPE } from "../lib/google";
import { dailyLimitReached, Drive, ensureChangesToken, GoogleError, runSync, type GFile } from "../lib/gsync";
import { cleanName } from "./files";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3";
const GOOGLE_ID = /^[\w-]+$/;

/** A Drive client for request handlers (no per-run budget beyond a generous cap). */
async function driveFor(env: Env, userId: string) {
  const token = (await hasScope(env, userId, DRIVE_READONLY_SCOPE)) ? await driveAccessToken(env, userId) : null;
  if (!token) fail(409, "Connect Google Drive sync first");
  return new Drive(token!, { fetches: 20, deadline: Date.now() + 25_000, writes: 0 });
}

async function ownSource(env: Env, id: string, userId: string) {
  const row = await env.DB.prepare("SELECT id FROM gsync_sources WHERE id = ? AND user_id = ?").bind(id, userId).first<{ id: string }>();
  if (!row) fail(404, "Synced folder not found");
}

const gsync = new Hono<AppEnv>();

/** Everything the sync page shows. Progress comes from counters on each source, so polling this is cheap. */
gsync.get("/gsync", async (c) => {
  const me = c.get("user").id;
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.name, s.google_folder_id AS googleFolderId, s.dest_folder_id AS destFolderId, s.status, s.status_message AS statusMessage,
            s.first_sync_done_at AS firstSyncDoneAt, u.changes_checked_at AS lastSyncedAt, s.created_at AS createdAt,
            s.n_done AS filesDone, s.n_pending AS filesPending, s.n_skipped AS filesSkipped, s.n_error AS filesFailed,
            s.bytes_done AS bytesDone, s.folders_pending AS foldersPending
       FROM gsync_sources s LEFT JOIN gsync_users u ON u.user_id = s.user_id
      WHERE s.user_id = ? ORDER BY s.created_at`,
  )
    .bind(me)
    .all();
  return c.json({
    connected: await hasScope(c.env, me, DRIVE_READONLY_SCOPE),
    dailyLimitReached: await dailyLimitReached(c.env),
    sources: results,
  });
});

/** Browse Google Drive folders for the picker: My Drive ("root"), a folder's subfolders, or "shared" (Shared with me). */
gsync.get("/gsync/folders", async (c) => {
  const parent = c.req.query("parent") || "root";
  if (!GOOGLE_ID.test(parent)) fail(400, "Invalid folder");
  const g = await driveFor(c.env, c.get("user").id);
  const q = parent === "shared" ? `sharedWithMe = true and mimeType = '${FOLDER_MIME}'` : `'${parent}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const res = await g.json<{ files: { id: string; name: string }[] }>(
    `${API}/files?q=${encodeURIComponent(q)}&orderBy=name_natural&pageSize=1000&fields=${encodeURIComponent("files(id,name)")}`,
  );
  return c.json({ folders: res.files });
});

/** Start syncing a Google folder into a new "Google Drive · <name>" folder in My Files. */
gsync.post("/gsync/sources", async (c) => {
  const me = c.get("user").id;
  const { googleFolderId } = await c.req.json<{ googleFolderId: string }>();
  if (typeof googleFolderId !== "string" || !GOOGLE_ID.test(googleFolderId)) fail(400, "Choose a Google Drive folder");
  const g = await driveFor(c.env, me);

  let folder: GFile;
  try {
    folder = await g.json<GFile>(`${API}/files/${googleFolderId}?fields=id,name,mimeType,trashed`); // resolves "root" to its real id
  } catch (err) {
    if (err instanceof GoogleError && err.status === 404) fail(404, "That Google Drive folder no longer exists");
    throw err;
  }
  if (folder!.mimeType !== FOLDER_MIME || folder!.trashed) fail(400, "Choose a Google Drive folder");
  const tracked = await c.env.DB.prepare(
    "SELECT s.name FROM gsync_items i JOIN gsync_sources s ON s.id = i.source_id WHERE i.user_id = ? AND i.google_id = ?",
  )
    .bind(me, folder!.id)
    .first<{ name: string }>();
  if (tracked) fail(409, `That folder is already syncing (as part of "${tracked.name}")`);

  // Watch for changes from before the first copy starts, so nothing added meanwhile is missed.
  await ensureChangesToken(c.env, g, me);

  const id = newId();
  const destId = newId();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO files (id, owner_id, parent_id, name, is_folder, size, created_at, updated_at, updated_by) VALUES (?, ?, NULL, ?, 1, 0, ?, ?, ?)",
    ).bind(destId, me, cleanName(`Google Drive · ${folder!.name}`), now, now, me),
    c.env.DB.prepare(
      "INSERT INTO gsync_sources (id, user_id, google_folder_id, name, dest_folder_id, status, folders_pending, created_at) VALUES (?, ?, ?, ?, ?, 'active', 1, ?)",
    ).bind(id, me, folder!.id, folder!.name, destId, now),
    c.env.DB.prepare(
      `INSERT INTO gsync_items (user_id, google_id, source_id, kind, name, google_parent_id, file_id, state, updated_at)
       VALUES (?, ?, ?, 'folder', ?, NULL, ?, 'pending', ?)`,
    ).bind(me, folder!.id, id, folder!.name, destId, now),
  ]);
  c.executionCtx.waitUntil(runSync(c.env, { userId: me }));
  return c.json({ id, destFolderId: destId }, 201);
});

gsync.post("/gsync/sources/:id/pause", async (c) => {
  const me = c.get("user").id;
  await ownSource(c.env, c.req.param("id"), me);
  await c.env.DB.prepare("UPDATE gsync_sources SET status = 'paused', status_message = NULL WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

/** Resume (also after "storage full" or reconnecting Google), retrying anything that failed. */
gsync.post("/gsync/sources/:id/resume", async (c) => {
  const me = c.get("user").id;
  const id = c.req.param("id");
  await ownSource(c.env, id, me);
  if (!(await hasScope(c.env, me, DRIVE_READONLY_SCOPE))) fail(409, "Connect Google Drive sync first");
  const { results: retried } = await c.env.DB.prepare(
    "UPDATE gsync_items SET state = 'pending', attempts = 0, retry_at = 0, error = NULL WHERE source_id = ? AND state = 'error' RETURNING kind",
  )
    .bind(id)
    .all<{ kind: string }>();
  const files = retried.filter((r) => r.kind === "file").length;
  await c.env.DB.prepare(
    `UPDATE gsync_sources SET status = 'active', status_message = NULL,
            n_error = n_error - ?2, n_pending = n_pending + ?3, folders_pending = folders_pending + ?4 WHERE id = ?1`,
  )
    .bind(id, retried.length, files, retried.length - files)
    .run();
  c.executionCtx.waitUntil(runSync(c.env, { userId: me, force: true }));
  return c.json({ ok: true });
});

gsync.post("/gsync/sources/:id/run", async (c) => {
  const me = c.get("user").id;
  await ownSource(c.env, c.req.param("id"), me);
  c.executionCtx.waitUntil(runSync(c.env, { userId: me, force: true }));
  return c.json({ ok: true });
});

/** Stop syncing. Files already copied stay in Family Drive. */
gsync.delete("/gsync/sources/:id", async (c) => {
  const me = c.get("user").id;
  await ownSource(c.env, c.req.param("id"), me);
  // Items are deleted explicitly rather than trusting the foreign-key cascade to be enforced.
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM gsync_items WHERE source_id = ?").bind(c.req.param("id")),
    c.env.DB.prepare("DELETE FROM gsync_sources WHERE id = ?").bind(c.req.param("id")),
  ]);
  return c.json({ ok: true });
});

export default gsync;
