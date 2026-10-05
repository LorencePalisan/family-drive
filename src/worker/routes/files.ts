import { Hono } from "hono";
import type { AppEnv } from "../types";
import { fail } from "../types";
import { newId } from "../lib/crypto";
import {
  descendantIds,
  fileDTO,
  isWithin,
  listAccessible,
  listPage,
  listTrash,
  requireAccess,
  requireWritableFolder,
  atLeast,
} from "../lib/access";
import { copyObject, fileKey, purgeFiles, thumbKey } from "../lib/storage";

export function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().replace(/[\u0000-\u001f/\\]/g, "_") : "";
  if (!name) fail(400, "Name can't be empty");
  if (name.length > 255) fail(400, "Name is too long");
  return name;
}

export async function touchRecent(env: Env, userId: string, fileId: string, action: "opened" | "modified" | "uploaded") {
  await env.DB.prepare(
    `INSERT INTO recents (user_id, file_id, action, at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (user_id, file_id) DO UPDATE SET action = ?3, at = ?4`,
  )
    .bind(userId, fileId, action, Date.now())
    .run();
}

/** A person's storage limit: the one the owner set for them, or the default. */
export const quotaFor = (env: Env, storageQuota: number | null | undefined) => storageQuota ?? Number(env.STORAGE_QUOTA_BYTES);

export async function assertQuota(env: Env, userId: string, extraBytes: number) {
  const row = await env.DB.prepare("SELECT storage_used, storage_quota FROM users WHERE id = ?")
    .bind(userId)
    .first<{ storage_used: number; storage_quota: number | null }>();
  if ((row?.storage_used ?? 0) + extraBytes > quotaFor(env, row?.storage_quota)) fail(413, "Not enough storage left");
}

// mime-type filters for search, matching the Drive "Type" chip.
const TYPE_FILTERS: Record<string, string> = {
  folder: "f.is_folder = 1",
  image: "f.mime LIKE 'image/%'",
  video: "f.mime LIKE 'video/%'",
  audio: "f.mime LIKE 'audio/%'",
  pdf: "f.mime = 'application/pdf'",
  document: `(f.mime IN ('application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.oasis.opendocument.text','application/rtf','text/plain') OR f.name LIKE '%.docx' OR f.name LIKE '%.doc')`,
  spreadsheet: `(f.mime IN ('application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.spreadsheet','text/csv') OR f.name LIKE '%.xlsx' OR f.name LIKE '%.csv')`,
  presentation: `(f.mime IN ('application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.presentation') OR f.name LIKE '%.pptx')`,
  archive: "f.mime IN ('application/zip','application/x-7z-compressed','application/x-rar-compressed','application/gzip','application/x-tar')",
};

const files = new Hono<AppEnv>();

// ---- Views -------------------------------------------------------------------------------------

// Candidate lists for the views below. They are bounded so a view never scans the whole drive.
const RECENT_IDS = (limit: number) => `SELECT file_id FROM recents WHERE user_id = ?1 ORDER BY at DESC LIMIT ${limit}`;
const RECENT_FOLDER_IDS = `SELECT r.file_id FROM recents r JOIN files x ON x.id = r.file_id
  WHERE r.user_id = ?1 AND x.is_folder = 1 ORDER BY r.at DESC LIMIT 30`;

files.get("/drive/home", async (c) => {
  const me = c.get("user").id;
  const [recentFolders, recentFiles] = await Promise.all([
    listAccessible(c.env, me, {
      where: `f.is_folder = 1 AND (f.id IN (${RECENT_FOLDER_IDS}) OR f.id IN (SELECT file_id FROM shares WHERE user_id = ?1)
              OR (f.owner_id = ?1 AND f.parent_id IS NULL))`,
      orderBy: "COALESCE(r.at, 0) DESC, f.updated_at DESC",
      limit: 8,
    }),
    listAccessible(c.env, me, {
      where: `f.is_folder = 0 AND f.id IN (${RECENT_IDS(60)})`,
      orderBy: "COALESCE(r.at, f.updated_at) DESC",
      limit: 30,
    }),
  ]);
  return c.json({ folders: recentFolders, files: recentFiles });
});

files.get("/drive/my", async (c) => {
  const me = c.get("user").id;
  return c.json(await listPage(c.env, me, { where: "f.owner_id = ?1 AND f.parent_id IS NULL", cursor: c.req.query("cursor") }));
});

files.get("/drive/recent", async (c) => {
  const me = c.get("user").id;
  const items = await listAccessible(c.env, me, { where: `f.is_folder = 0 AND f.id IN (${RECENT_IDS(300)})`, orderBy: "r.at DESC", limit: 200 });
  return c.json({ items });
});

files.get("/drive/starred", async (c) => {
  const me = c.get("user").id;
  return c.json({ items: await listAccessible(c.env, me, { where: "f.id IN (SELECT file_id FROM stars WHERE user_id = ?1)" }) });
});

files.get("/drive/shared", async (c) => {
  const me = c.get("user").id;
  const items = await listAccessible(c.env, me, {
    where: "f.owner_id <> ?1 AND f.id IN (SELECT file_id FROM shares WHERE user_id = ?1)",
    orderBy: "(SELECT MAX(s.created_at) FROM shares s WHERE s.file_id = f.id AND s.user_id = ?1) DESC",
  });
  return c.json({ items });
});

files.get("/drive/trash", async (c) => c.json({ items: await listTrash(c.env, c.get("user").id) }));

files.get("/drive/search", async (c) => {
  const me = c.get("user").id;
  const q = (c.req.query("q") ?? "").trim();
  const type = c.req.query("type") ?? "";
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q.length >= 3) {
    // Trigram index (migration 0002): a quoted phrase matches as a case-insensitive substring.
    conds.push(`f.id IN (SELECT s.file_id FROM files_fts JOIN file_search_ids s ON s.rid = files_fts.rowid WHERE files_fts MATCH ?2)`);
    params.push(`"${q.replace(/"/g, '""')}"`);
  } else if (q) {
    // Too short for trigrams; scan names instead.
    conds.push(`f.name LIKE ?2 ESCAPE '\\'`);
    params.push(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  if (TYPE_FILTERS[type]) conds.push(TYPE_FILTERS[type]);
  if (c.req.query("owner") === "me") conds.push("f.owner_id = ?1");
  if (c.req.query("owner") === "others") conds.push("f.owner_id <> ?1");
  if (!conds.length) return c.json({ items: [] });
  const items = await listAccessible(c.env, me, { where: conds.join(" AND "), params, orderBy: "f.updated_at DESC", limit: 300 });
  return c.json({ items });
});

files.get("/folders/:id", async (c) => {
  const me = c.get("user").id;
  const { file } = await requireAccess(c.env, c.req.param("id"), me, "viewer");
  if (!file.is_folder) fail(400, "Not a folder");
  const cursor = c.req.query("cursor");
  // Later pages only need the next batch of children; the first also carries the folder and its path.
  if (cursor) return c.json(await listPage(c.env, me, { where: "f.parent_id = ?2", params: [file.id], cursor }));

  const { results: chain } = await c.env.DB.prepare(
    `WITH RECURSIVE anc(id, parent_id, name, owner_id, depth) AS (
       SELECT id, parent_id, name, owner_id, 0 FROM files WHERE id = ?1
       UNION ALL SELECT f.id, f.parent_id, f.name, f.owner_id, anc.depth + 1 FROM files f JOIN anc ON f.id = anc.parent_id
     ) SELECT id, parent_id, name, owner_id FROM anc ORDER BY depth`,
  )
    .bind(file.id)
    .all<{ id: string; parent_id: string | null; name: string; owner_id: string }>();
  const visible = new Set(
    (
      await listAccessible(c.env, me, {
        where: `f.id IN (${chain.map((_, i) => `?${i + 2}`).join(",")})`,
        params: chain.map((a) => a.id),
      })
    ).map((d) => d.id),
  );
  const path: { id: string | null; name: string }[] = [];
  for (const a of chain) {
    if (!visible.has(a.id)) break;
    path.unshift({ id: a.id, name: a.name });
  }
  const top = chain[path.length - 1];
  path.unshift({ id: null, name: top && top.owner_id === me && !top.parent_id ? "My Files" : "Shared with me" });

  const [folder, page] = await Promise.all([fileDTO(c.env, file.id, me), listPage(c.env, me, { where: "f.parent_id = ?2", params: [file.id] })]);
  return c.json({ folder, path, ...page });
});

// ---- Mutations ---------------------------------------------------------------------------------

files.post("/folders", async (c) => {
  const me = c.get("user").id;
  const body = await c.req.json<{ name: string; parentId?: string | null }>();
  const name = cleanName(body.name);
  const parent = await requireWritableFolder(c.env, body.parentId, me);
  const now = Date.now();
  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO files (id, owner_id, parent_id, name, is_folder, size, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)`,
  )
    .bind(id, me, parent?.id ?? null, name, now, now, me)
    .run();
  await touchRecent(c.env, me, id, "modified");
  return c.json(await fileDTO(c.env, id, me), 201);
});

files.get("/files/:id", async (c) => {
  const me = c.get("user").id;
  const { file } = await requireAccess(c.env, c.req.param("id"), me, "viewer", { allowTrashed: true });
  const [dto, versions, updater] = await Promise.all([
    fileDTO(c.env, file.id, me),
    c.env.DB.prepare(
      `SELECT v.id, v.size, v.source, v.created_at AS createdAt, u.name AS createdBy
         FROM file_versions v JOIN users u ON u.id = v.created_by WHERE v.file_id = ? ORDER BY v.created_at DESC`,
    )
      .bind(file.id)
      .all(),
    file.updated_by ? c.env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(file.updated_by).first<{ name: string }>() : null,
  ]);
  return c.json({ ...(dto ?? {}), trashedAt: file.trashed_at, updatedByName: updater?.name ?? null, versions: versions.results });
});

files.post("/files/:id/opened", async (c) => {
  const me = c.get("user").id;
  await requireAccess(c.env, c.req.param("id"), me, "viewer");
  await touchRecent(c.env, me, c.req.param("id"), "opened");
  return c.json({ ok: true });
});

files.patch("/files/:id", async (c) => {
  const me = c.get("user").id;
  const { file } = await requireAccess(c.env, c.req.param("id"), me, "editor");
  const body = await c.req.json<{ name?: string; parentId?: string | null }>();
  const now = Date.now();

  if (body.name !== undefined) {
    await c.env.DB.prepare("UPDATE files SET name = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .bind(cleanName(body.name), now, me, file.id)
      .run();
  }
  if (body.parentId !== undefined && body.parentId !== file.parent_id) {
    if (body.parentId === null) {
      if (file.owner_id !== me) fail(403, "Only the owner can move this to their My Files");
    } else {
      await requireWritableFolder(c.env, body.parentId, me);
      if (file.is_folder && (await isWithin(c.env, body.parentId, file.id))) fail(400, "Can't move a folder into itself");
    }
    await c.env.DB.prepare("UPDATE files SET parent_id = ?, updated_at = ?, updated_by = ? WHERE id = ?")
      .bind(body.parentId, now, me, file.id)
      .run();
  }
  await touchRecent(c.env, me, file.id, "modified");
  return c.json(await fileDTO(c.env, file.id, me));
});

files.post("/files/:id/copy", async (c) => {
  const me = c.get("user").id;
  const { file } = await requireAccess(c.env, c.req.param("id"), me, "viewer");
  if (file.is_folder) fail(400, "Folders can't be copied yet");
  if (!file.current_version_id) fail(409, "File is still uploading");
  const body = await c.req.json<{ parentId?: string | null; name?: string }>().catch(() => ({}) as { parentId?: string | null; name?: string });

  // Default: next to the original if we may write there, otherwise into My Files.
  let parentId: string | null = null;
  if (body.parentId !== undefined) parentId = (await requireWritableFolder(c.env, body.parentId, me))?.id ?? null;
  else if (file.parent_id) {
    const parent = await requireAccess(c.env, file.parent_id, me, "viewer").catch(() => null);
    if (parent && atLeast(parent.role, "editor")) parentId = file.parent_id;
  }
  await assertQuota(c.env, me, file.size);

  const src = await c.env.DB.prepare("SELECT r2_key FROM file_versions WHERE id = ?").bind(file.current_version_id).first<{ r2_key: string }>();
  if (!src) fail(500, "Missing file version");
  const id = newId();
  const versionId = newId();
  const key = fileKey(id, versionId);
  await copyObject(c.env.BUCKET, src!.r2_key, key, file.size, file.mime);
  let thumb: string | null = null;
  if (file.thumb_key) {
    const t = await c.env.BUCKET.get(file.thumb_key);
    if (t) {
      thumb = thumbKey(id);
      await c.env.BUCKET.put(thumb, t.body, { httpMetadata: { contentType: "image/webp" } });
    }
  }
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO files (id, owner_id, parent_id, name, is_folder, mime, size, current_version_id, thumb_key, width, height, duration, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, me, parentId, body.name ? cleanName(body.name) : `Copy of ${file.name}`, file.mime, file.size, versionId, thumb, file.width, file.height, file.duration, now, now, me),
    c.env.DB.prepare(
      "INSERT INTO file_versions (id, file_id, r2_key, size, mime, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'copy', ?, ?)",
    ).bind(versionId, id, key, file.size, file.mime, me, now),
    c.env.DB.prepare("UPDATE users SET storage_used = storage_used + ? WHERE id = ?").bind(file.size, me),
  ]);
  await touchRecent(c.env, me, id, "modified");
  return c.json(await fileDTO(c.env, id, me), 201);
});

files.put("/files/:id/star", async (c) => {
  const me = c.get("user").id;
  await requireAccess(c.env, c.req.param("id"), me, "viewer");
  const { starred } = await c.req.json<{ starred: boolean }>();
  await c.env.DB.prepare(
    starred
      ? "INSERT OR IGNORE INTO stars (user_id, file_id, created_at) VALUES (?1, ?2, ?3)"
      : "DELETE FROM stars WHERE user_id = ?1 AND file_id = ?2",
  )
    .bind(me, c.req.param("id"), ...(starred ? [Date.now()] : []))
    .run();
  return c.json({ starred });
});

files.post("/files/:id/trash", async (c) => {
  const me = c.get("user").id;
  const { file } = await requireAccess(c.env, c.req.param("id"), me, "editor");
  await c.env.DB.prepare(
    `WITH RECURSIVE d(id) AS (SELECT ?1 UNION ALL SELECT f.id FROM files f JOIN d ON f.parent_id = d.id)
     UPDATE files SET trashed_at = ?2, trashed_by = ?3 WHERE id IN (SELECT id FROM d) AND trashed_at IS NULL`,
  )
    .bind(file.id, Date.now(), me)
    .run();
  return c.json({ ok: true });
});

files.post("/files/:id/restore", async (c) => {
  const me = c.get("user").id;
  const { file } = await requireAccess(c.env, c.req.param("id"), me, "editor", { allowTrashed: true });
  if (!file.trashed_at) return c.json({ ok: true });
  await c.env.DB.prepare(
    `WITH RECURSIVE d(id) AS (SELECT ?1 UNION ALL SELECT f.id FROM files f JOIN d ON f.parent_id = d.id)
     UPDATE files SET trashed_at = NULL, trashed_by = NULL WHERE id IN (SELECT id FROM d) AND trashed_at = ?2`,
  )
    .bind(file.id, file.trashed_at)
    .run();
  // If the original folder is gone or still in the trash, restore to the owner's My Files.
  await c.env.DB.prepare(
    `UPDATE files SET parent_id = NULL WHERE id = ?1 AND parent_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM files p WHERE p.id = files.parent_id AND p.trashed_at IS NULL)`,
  )
    .bind(file.id)
    .run();
  return c.json(await fileDTO(c.env, file.id, me));
});

files.delete("/files/:id", async (c) => {
  const me = c.get("user").id;
  const { file } = await requireAccess(c.env, c.req.param("id"), me, "owner", { allowTrashed: true });
  await purgeFiles(c.env, await descendantIds(c.env, file.id));
  return c.json({ ok: true });
});

files.delete("/drive/trash", async (c) => {
  const me = c.get("user").id;
  const top = (await listTrash(c.env, me)).filter((f) => f.owner.isMe);
  for (const f of top) await purgeFiles(c.env, await descendantIds(c.env, f.id));
  return c.json({ deleted: top.length });
});

export default files;
