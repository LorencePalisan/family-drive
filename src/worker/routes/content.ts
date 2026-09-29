import { Hono } from "hono";
import { downloadZip } from "client-zip";
import type { AppEnv } from "../types";
import { fail } from "../types";
import { requireAccess, isWithin, type FileRecord } from "../lib/access";
import { contentDisposition, serveObject } from "../lib/storage";
import { requireUser } from "../lib/session";

async function versionKey(env: Env, file: FileRecord, versionId?: string) {
  if (file.is_folder) fail(400, "Folders have no content");
  const row = await env.DB.prepare("SELECT r2_key, mime FROM file_versions WHERE id = ? AND file_id = ?")
    .bind(versionId || file.current_version_id, file.id)
    .first<{ r2_key: string; mime: string | null }>();
  if (!row) fail(404, "Version not found");
  return row!;
}

async function serveFile(c: { env: Env; req: { raw: Request; query: (k: string) => string | undefined } }, file: FileRecord) {
  const v = await versionKey(c.env, file, c.req.query("v"));
  return serveObject(c.env.BUCKET, c.req.raw, {
    key: v.r2_key,
    name: file.name,
    mime: v.mime ?? file.mime,
    download: c.req.query("download") === "1",
  });
}

async function serveThumb(env: Env, file: FileRecord) {
  if (!file.thumb_key) return new Response("No thumbnail", { status: 404 });
  const obj = await env.BUCKET.get(file.thumb_key);
  if (!obj) return new Response("No thumbnail", { status: 404 });
  return new Response(obj.body, {
    headers: { "content-type": obj.httpMetadata?.contentType ?? "image/webp", "cache-control": "private, max-age=86400", etag: obj.httpEtag },
  });
}

/** Stream a folder as a zip (stored, not compressed — photos/videos don't compress anyway). */
async function serveZip(env: Env, folder: FileRecord) {
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE t(id, path, is_folder) AS (
       SELECT id, name, is_folder FROM files WHERE id = ?1
       UNION ALL
       SELECT f.id, t.path || '/' || f.name, f.is_folder FROM files f JOIN t ON f.parent_id = t.id WHERE f.trashed_at IS NULL
     )
     SELECT t.path, f.size, f.updated_at, v.r2_key
       FROM t JOIN files f ON f.id = t.id JOIN file_versions v ON v.id = f.current_version_id
      WHERE t.is_folder = 0`,
  )
    .bind(folder.id)
    .all<{ path: string; size: number; updated_at: number; r2_key: string }>();

  async function* entries() {
    for (const r of results) {
      const obj = await env.BUCKET.get(r.r2_key);
      if (obj) yield { name: r.path, input: obj.body, size: r.size, lastModified: new Date(r.updated_at) };
    }
  }
  const res = downloadZip(entries());
  return new Response(res.body, {
    headers: { "content-type": "application/zip", "content-disposition": contentDisposition("attachment", `${folder.name}.zip`) },
  });
}

// ---- Signed-in access --------------------------------------------------------------------------

export const content = new Hono<AppEnv>()
  .use(requireUser)
  .get("/:id/content", async (c) => {
    const { file } = await requireAccess(c.env, c.req.param("id"), c.get("user").id, "viewer");
    return serveFile(c, file);
  })
  .get("/:id/thumbnail", async (c) => {
    const { file } = await requireAccess(c.env, c.req.param("id"), c.get("user").id, "viewer");
    return serveThumb(c.env, file);
  })
  .get("/:id/zip", async (c) => {
    const { file } = await requireAccess(c.env, c.req.param("id"), c.get("user").id, "viewer");
    if (!file.is_folder) fail(400, "Not a folder");
    return serveZip(c.env, file);
  });

// ---- Public share links ("Anyone with the link can view") ---------------------------------------

async function resolveLink(env: Env, token: string, targetId?: string) {
  const link = await env.DB.prepare(
    `SELECT l.file_id, u.name AS shared_by FROM share_links l JOIN users u ON u.id = l.created_by
      WHERE l.token = ? AND l.disabled_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > ?)`,
  )
    .bind(token, Date.now())
    .first<{ file_id: string; shared_by: string }>();
  if (!link) fail(404, "This link doesn't work anymore");
  const id = targetId || link!.file_id;
  if (id !== link!.file_id && !(await isWithin(env, id, link!.file_id))) fail(404, "Not found");
  const file = await env.DB.prepare("SELECT * FROM files WHERE id = ? AND trashed_at IS NULL").bind(id).first<FileRecord>();
  if (!file) fail(404, "This file was deleted");
  return { root: link!.file_id, sharedBy: link!.shared_by, file: file! };
}

const publicDTO = (f: FileRecord) => ({
  id: f.id,
  name: f.name,
  isFolder: !!f.is_folder,
  mime: f.mime,
  size: f.size,
  hasThumbnail: !!f.thumb_key,
  width: f.width,
  height: f.height,
  updatedAt: f.updated_at,
});

export const publicLinks = new Hono<AppEnv>()
  .get("/:token", async (c) => {
    const { root, sharedBy, file } = await resolveLink(c.env, c.req.param("token"), c.req.query("folderId"));
    let items: ReturnType<typeof publicDTO>[] = [];
    if (file.is_folder) {
      const { results } = await c.env.DB.prepare(
        "SELECT * FROM files WHERE parent_id = ? AND trashed_at IS NULL ORDER BY is_folder DESC, name COLLATE NOCASE",
      )
        .bind(file.id)
        .all<FileRecord>();
      items = results.map(publicDTO);
    }
    return c.json({ rootId: root, sharedBy, file: publicDTO(file), items });
  })
  .get("/:token/content", async (c) => {
    const { file } = await resolveLink(c.env, c.req.param("token"), c.req.query("fileId"));
    return serveFile(c, file);
  })
  .get("/:token/thumbnail", async (c) => {
    const { file } = await resolveLink(c.env, c.req.param("token"), c.req.query("fileId"));
    return serveThumb(c.env, file);
  })
  .get("/:token/zip", async (c) => {
    const { file } = await resolveLink(c.env, c.req.param("token"), c.req.query("fileId"));
    if (!file.is_folder) fail(400, "Not a folder");
    return serveZip(c.env, file);
  });
