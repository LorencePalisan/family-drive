import { Hono } from "hono";
import type { AppEnv } from "../types";
import { fail } from "../types";
import { newId } from "../lib/crypto";
import { fileDTO, requireAccess, requireWritableFolder } from "../lib/access";
import { fileKey, PART_SIZE, thumbKey } from "../lib/storage";
import { notify } from "../lib/notify";
import { assertQuota, cleanName, touchRecent } from "./files";

type UploadRow = {
  id: string;
  user_id: string;
  r2_upload_id: string;
  r2_key: string;
  file_id: string;
  version_id: string;
  parent_id: string | null;
  name: string;
  mime: string | null;
  size: number;
  part_size: number;
  status: string;
};

const MAX_PARTS = 10_000;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;

const uploads = new Hono<AppEnv>();

async function loadUpload(env: Env, id: string, userId: string) {
  const row = await env.DB.prepare("SELECT * FROM uploads WHERE id = ? AND user_id = ?").bind(id, userId).first<UploadRow>();
  if (!row) fail(404, "Upload not found");
  if (row!.status !== "pending") fail(409, `Upload is already ${row!.status}`);
  return row!;
}

/** Start a multipart upload. The browser then PUTs each part to /uploads/:id/parts/:n. */
uploads.post("/uploads", async (c) => {
  const me = c.get("user").id;
  const body = await c.req.json<{ name: string; size: number; mime?: string; parentId?: string | null }>();
  const name = cleanName(body.name);
  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 0) fail(400, "Invalid size");
  if (Math.ceil(size / PART_SIZE) > MAX_PARTS) fail(413, "File is too large");
  const parent = await requireWritableFolder(c.env, body.parentId, me);
  await assertQuota(c.env, me, size);

  const id = newId();
  const fileId = newId();
  const versionId = newId();
  const key = fileKey(fileId, versionId);
  const mime = body.mime || "application/octet-stream";
  const mpu = await c.env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: mime } });
  await c.env.DB.prepare(
    `INSERT INTO uploads (id, user_id, r2_upload_id, r2_key, file_id, version_id, parent_id, name, mime, size, part_size, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  )
    .bind(id, me, mpu.uploadId, key, fileId, versionId, parent?.id ?? null, name, mime, size, PART_SIZE, Date.now())
    .run();
  return c.json({ uploadId: id, fileId, partSize: PART_SIZE, partCount: Math.max(1, Math.ceil(size / PART_SIZE)) }, 201);
});

uploads.put("/uploads/:id/parts/:n", async (c) => {
  const up = await loadUpload(c.env, c.req.param("id"), c.get("user").id);
  const n = Number(c.req.param("n"));
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) fail(400, "Invalid part number");
  const len = Number(c.req.header("content-length"));
  if (!c.req.raw.body || !Number.isFinite(len) || len > up.part_size) fail(400, "Invalid part body");
  const part = await c.env.BUCKET.resumeMultipartUpload(up.r2_key, up.r2_upload_id).uploadPart(n, c.req.raw.body!);
  return c.json(part);
});

uploads.post("/uploads/:id/complete", async (c) => {
  const me = c.get("user");
  const up = await loadUpload(c.env, c.req.param("id"), me.id);
  const body = await c.req.json<{
    parts: R2UploadedPart[];
    width?: number;
    height?: number;
    duration?: number;
  }>();
  const parts = [...body.parts].sort((a, b) => a.partNumber - b.partNumber);
  const obj = await c.env.BUCKET.resumeMultipartUpload(up.r2_key, up.r2_upload_id).complete(parts);
  if (obj.size !== up.size) {
    await c.env.BUCKET.delete(up.r2_key);
    await c.env.DB.prepare("UPDATE uploads SET status = 'aborted' WHERE id = ?").bind(up.id).run();
    fail(400, `Upload size mismatch (${obj.size} ≠ ${up.size})`);
  }

  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO files (id, owner_id, parent_id, name, is_folder, mime, size, current_version_id, width, height, duration, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(up.file_id, me.id, up.parent_id, up.name, up.mime, up.size, up.version_id, int(body.width), int(body.height), int(body.duration), now, now, me.id),
    c.env.DB.prepare(
      "INSERT INTO file_versions (id, file_id, r2_key, size, mime, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'upload', ?, ?)",
    ).bind(up.version_id, up.file_id, up.r2_key, up.size, up.mime, me.id, now),
    c.env.DB.prepare("UPDATE users SET storage_used = storage_used + ? WHERE id = ?").bind(up.size, me.id),
    c.env.DB.prepare("UPDATE uploads SET status = 'completed' WHERE id = ?").bind(up.id),
  ]);
  await touchRecent(c.env, me.id, up.file_id, "uploaded");

  // Let the folder owner know when someone else adds to their folder.
  if (up.parent_id) {
    const parent = await c.env.DB.prepare("SELECT owner_id, name FROM files WHERE id = ?").bind(up.parent_id).first<{ owner_id: string; name: string }>();
    if (parent && parent.owner_id !== me.id) {
      await notify(c.env, { userId: parent.owner_id, type: "file_added", actorId: me.id, fileId: up.file_id, payload: { folderName: parent.name } });
    }
  }
  return c.json(await fileDTO(c.env, up.file_id, me.id), 201);
});

uploads.delete("/uploads/:id", async (c) => {
  const up = await loadUpload(c.env, c.req.param("id"), c.get("user").id);
  await c.env.BUCKET.resumeMultipartUpload(up.r2_key, up.r2_upload_id).abort().catch(() => {});
  await c.env.DB.prepare("UPDATE uploads SET status = 'aborted' WHERE id = ?").bind(up.id).run();
  return c.json({ ok: true });
});

uploads.put("/files/:id/thumbnail", async (c) => {
  const { file } = await requireAccess(c.env, c.req.param("id"), c.get("user").id, "editor");
  const type = c.req.header("content-type") ?? "";
  if (!/^image\/(webp|jpeg|png)$/.test(type)) fail(400, "Thumbnail must be webp, jpeg or png");
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > MAX_THUMB_BYTES) fail(413, "Thumbnail too large");
  const key = thumbKey(file.id);
  await c.env.BUCKET.put(key, buf, { httpMetadata: { contentType: type } });
  await c.env.DB.prepare("UPDATE files SET thumb_key = ? WHERE id = ?").bind(key, file.id).run();
  return c.json({ ok: true });
});

export default uploads;
