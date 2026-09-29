/**
 * One-way Google Drive → Family Drive sync.
 *
 * Someone picks Google folders to sync (a "source"). Every folder/file inside becomes a row in gsync_items:
 * folders are listed to discover their children, files are streamed from Google into R2. After the first copy,
 * the Drive Changes API tells us about new, edited and renamed files. Deletions in Google are ignored on purpose,
 * and anything removed in Family Drive is never re-added.
 *
 * Work runs in small batches (cron every minute, plus right after someone adds a folder or presses "Sync now")
 * because Workers Free allows only ~50 outgoing requests and ~50 D1 queries per invocation.
 * Anything unfinished, including a large file's multipart upload, simply continues on the next run.
 */
import { newId } from "./crypto";
import { driveAccessToken, hasScope, DRIVE_READONLY_SCOPE } from "./google";
import { fileKey, thumbKey } from "./storage";
import { notify } from "./notify";
import { cleanName, quotaFor } from "../routes/files";

/** Per-run limits sized for Workers Free. On Workers Paid these can be raised a lot (1000 requests/queries per run). */
export const SYNC_LIMITS = { fetches: 40, files: 5, folders: 3, changesEveryMs: 4 * 60_000, partSize: 100 * 1024 * 1024 };

const API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MAX_ATTEMPTS = 5;
const LEASE_MS = 10 * 60_000;
const ITEM_FIELDS = "id,name,mimeType,parents,trashed,md5Checksum,modifiedTime,size,appProperties";

export const MSG = {
  removedHere: "Removed in Family Drive",
  parentRemoved: "Its folder was removed in Family Drive",
  trashedInGoogle: "In Google Drive trash",
  deletedInGoogle: "Deleted from Google Drive",
  madeByUs: "Created by Family Drive (Open with Google)",
  storageFull: "Storage full. Free up space (or ask the owner for a bigger limit), then press Resume.",
  reconnect: "Reconnect Google Drive to keep syncing.",
} as const;

/** Google Docs/Sheets/Slides/Drawings are exported to regular files; other Google types (Forms, Sites, shortcuts…) are skipped. */
const NATIVE: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  "application/vnd.google-apps.spreadsheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  "application/vnd.google-apps.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" },
  "application/vnd.google-apps.drawing": { mime: "image/png", ext: "png" },
};

export type GFile = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  trashed?: boolean;
  md5Checksum?: string;
  modifiedTime?: string;
  size?: string;
  appProperties?: Record<string, string>;
};

type GFileFull = GFile & {
  thumbnailLink?: string;
  exportLinks?: Record<string, string>;
  imageMediaMetadata?: { width?: number; height?: number };
  videoMediaMetadata?: { width?: number; height?: number; durationMillis?: string };
};

type ItemRow = {
  user_id: string;
  google_id: string;
  source_id: string;
  kind: "folder" | "file";
  name: string;
  google_parent_id: string | null;
  file_id: string | null;
  google_version: string | null;
  size: number;
  state: "pending" | "done" | "skipped" | "error";
  error: string | null;
  attempts: number;
  page_token: string | null;
  mpu_id: string | null;
  mpu_key: string | null;
  mpu_version_id: string | null;
  mpu_parts: string | null;
  mpu_offset: number;
};

// ---- Google API with a per-run request budget ---------------------------------------------------

export type Budget = { fetches: number; deadline: number };
export class OutOfBudget extends Error {}
export class GoogleError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Drive {
  constructor(
    private token: string,
    private budget: Budget,
  ) {}

  get canFetch() {
    return this.budget.fetches > 0 && Date.now() < this.budget.deadline;
  }

  async fetch(url: string, init: RequestInit = {}) {
    if (!this.canFetch) throw new OutOfBudget();
    this.budget.fetches--;
    const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${this.token}` } });
    if (!res.ok) {
      const text = await res.text();
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {}
      throw new GoogleError(res.status, `Google Drive: ${message}`);
    }
    return res;
  }

  json<T>(url: string) {
    return this.fetch(url).then((r) => r.json<T>());
  }
}

// ---- Helpers ------------------------------------------------------------------------------------

/** What identifies a version of a Google file: its checksum, or for Google Docs (no checksum) its last edit time. */
export const versionOf = (f: GFile) => f.md5Checksum ?? f.modifiedTime ?? null;

const withExt = (name: string, ext: string) => (name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`);

/** The name a Google item gets in Family Drive (Google Docs get their export extension). */
export function familyName(f: Pick<GFile, "name" | "mimeType">) {
  const native = NATIVE[f.mimeType];
  const safe = f.name.trim() ? f.name : "Untitled";
  return cleanName(native ? withExt(safe, native.ext) : safe);
}

/** How a newly discovered Google item should be tracked. */
function classify(f: GFile): { kind: "folder" | "file"; state: "pending" | "skipped"; error: string | null } {
  if (f.mimeType === FOLDER_MIME) return { kind: "folder", state: "pending", error: null };
  if (f.appProperties?.familyDrive) return { kind: "file", state: "skipped", error: MSG.madeByUs };
  if (f.mimeType.startsWith("application/vnd.google-apps.") && !NATIVE[f.mimeType]) {
    const type = f.mimeType.split(".").pop() ?? "file";
    return { kind: "file", state: "skipped", error: `Google ${type[0].toUpperCase()}${type.slice(1)} items can't be copied` };
  }
  return { kind: "file", state: "pending", error: null };
}

/** Track new Google items (one statement for the whole list, via json_each). Items already tracked are left alone. */
export async function insertItems(env: Env, userId: string, sourceId: string, files: GFile[], parentId?: string) {
  if (!files.length) return;
  const rows = files.map((f) => {
    const c = classify(f);
    return { id: f.id, name: f.name, kind: c.kind, parent: parentId ?? f.parents?.[0] ?? null, size: Number(f.size ?? 0), state: c.state, error: c.error };
  });
  await env.DB.prepare(
    `INSERT OR IGNORE INTO gsync_items (user_id, google_id, source_id, kind, name, google_parent_id, size, state, error, updated_at)
     SELECT ?1, json_extract(value, '$.id'), ?2, json_extract(value, '$.kind'), json_extract(value, '$.name'), json_extract(value, '$.parent'),
            json_extract(value, '$.size'), json_extract(value, '$.state'), json_extract(value, '$.error'), ?3
       FROM json_each(?4)`,
  )
    .bind(userId, sourceId, Date.now(), JSON.stringify(rows))
    .run();
}

async function aliveFolder(env: Env, fileId: string | null) {
  if (!fileId) return false;
  return !!(await env.DB.prepare("SELECT 1 FROM files WHERE id = ? AND is_folder = 1 AND trashed_at IS NULL").bind(fileId).first());
}

async function hasRoom(env: Env, userId: string, bytes: number) {
  const row = await env.DB.prepare("SELECT storage_used, storage_quota FROM users WHERE id = ?")
    .bind(userId)
    .first<{ storage_used: number; storage_quota: number | null }>();
  return !!row && row.storage_used + bytes <= quotaFor(env, row.storage_quota);
}

const setItem = (env: Env, item: Pick<ItemRow, "user_id" | "google_id">, fields: Record<string, unknown>) => {
  const cols = Object.keys(fields);
  return env.DB.prepare(`UPDATE gsync_items SET ${cols.map((k, i) => `${k} = ?${i + 3}`).join(", ")}, updated_at = ?${cols.length + 3} WHERE user_id = ?1 AND google_id = ?2`)
    .bind(item.user_id, item.google_id, ...Object.values(fields), Date.now())
    .run();
};

const skip = (env: Env, item: ItemRow, reason: string) => setItem(env, item, { state: "skipped", error: reason, page_token: null });

/** A failed item is retried with backoff (2, 4, 8, 16 min) and then marked as an error the person can see and retry. */
async function failItem(env: Env, item: ItemRow, err: unknown) {
  const attempts = item.attempts + 1;
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  console.warn("gsync item failed", item.google_id, message);
  await setItem(env, item, attempts >= MAX_ATTEMPTS ? { state: "error", error: message, attempts } : { error: message, attempts, retry_at: Date.now() + 2 ** attempts * 60_000 });
}

// ---- Run ----------------------------------------------------------------------------------------

/** Process sync work for everyone with an active source (or just one person), within one invocation's limits. */
export async function runSync(env: Env, opts: { userId?: string; force?: boolean; ms?: number } = {}) {
  const budget: Budget = { fetches: SYNC_LIMITS.fetches, deadline: Date.now() + (opts.ms ?? 25_000) };
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM gsync_sources WHERE status = 'active'${opts.userId ? " AND user_id = ?" : ""}`,
  )
    .bind(...(opts.userId ? [opts.userId] : []))
    .all<{ user_id: string }>();
  // Shuffle so one person's big first sync can't starve everyone else's.
  const users = results.map((r) => r.user_id).sort(() => Math.random() - 0.5);
  for (const userId of users) {
    if (budget.fetches < 3 || Date.now() > budget.deadline) break;
    await runUser(env, userId, budget, !!opts.force);
  }
}

async function runUser(env: Env, userId: string, budget: Budget, force: boolean) {
  const now = Date.now();
  // Lease the person so overlapping runs (cron + "Sync now") don't process the same items twice.
  const lease = await env.DB.prepare(
    `INSERT INTO gsync_users (user_id, locked_until) VALUES (?1, ?2)
     ON CONFLICT (user_id) DO UPDATE SET locked_until = ?2 WHERE gsync_users.locked_until < ?3
     RETURNING changes_page_token, changes_checked_at`,
  )
    .bind(userId, now + LEASE_MS, now)
    .first<{ changes_page_token: string | null; changes_checked_at: number }>();
  if (!lease) return;

  try {
    const token = (await hasScope(env, userId, DRIVE_READONLY_SCOPE)) ? await driveAccessToken(env, userId) : null;
    budget.fetches--;
    if (!token) {
      await env.DB.prepare("UPDATE gsync_sources SET status = 'error', status_message = ? WHERE user_id = ? AND status = 'active'")
        .bind(MSG.reconnect, userId)
        .run();
      return;
    }
    const g = new Drive(token, budget);
    if (force || now - lease.changes_checked_at > SYNC_LIMITS.changesEveryMs) await pullChanges(env, g, userId, lease.changes_page_token);
    await processFolders(env, g, userId);
    await processFiles(env, g, userId);
    await finishSources(env, userId);
  } catch (err) {
    if (!(err instanceof OutOfBudget)) console.error("gsync run failed", userId, err);
  } finally {
    await env.DB.prepare("UPDATE gsync_users SET locked_until = 0 WHERE user_id = ?").bind(userId).run();
  }
}

/** Start watching for changes from now on (called before a source's first walk, so nothing is missed in between). */
export async function ensureChangesToken(env: Env, g: Drive, userId: string) {
  const row = await env.DB.prepare("SELECT changes_page_token FROM gsync_users WHERE user_id = ?").bind(userId).first<{ changes_page_token: string | null }>();
  if (row?.changes_page_token) return;
  const { startPageToken } = await g.json<{ startPageToken: string }>(`${API}/changes/startPageToken`);
  await env.DB.prepare(
    `INSERT INTO gsync_users (user_id, changes_page_token, changes_checked_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (user_id) DO UPDATE SET changes_page_token = ?2, changes_checked_at = ?3`,
  )
    .bind(userId, startPageToken, Date.now())
    .run();
}

// ---- Changes (new, edited and renamed files after the first copy) -------------------------------

async function pullChanges(env: Env, g: Drive, userId: string, pageToken: string | null) {
  let token = pageToken;
  while (token && g.canFetch) {
    const page = await g.json<{
      nextPageToken?: string;
      newStartPageToken?: string;
      changes: { fileId: string; removed?: boolean; file?: GFile }[];
    }>(
      `${API}/changes?pageToken=${encodeURIComponent(token)}&pageSize=1000&spaces=drive` +
        `&fields=${encodeURIComponent(`nextPageToken,newStartPageToken,changes(fileId,removed,file(${ITEM_FIELDS}))`)}`,
    );
    // Deletions and trashing in Google are deliberately ignored: this is a backup, not a mirror.
    await applyChanges(env, userId, page.changes.filter((c) => !c.removed && c.file && !c.file.trashed).map((c) => c.file!));
    token = page.nextPageToken ?? null;
    await env.DB.prepare("UPDATE gsync_users SET changes_page_token = ?, changes_checked_at = ? WHERE user_id = ?")
      .bind(page.nextPageToken ?? page.newStartPageToken ?? pageToken, Date.now(), userId)
      .run();
  }
}

export async function applyChanges(env: Env, userId: string, files: GFile[]) {
  if (!files.length) return;
  const ids = [...new Set(files.flatMap((f) => [f.id, ...(f.parents ?? [])]))];
  const { results } = await env.DB.prepare(
    `SELECT google_id, source_id, kind, name, google_parent_id, file_id, google_version, state, error
       FROM gsync_items WHERE user_id = ? AND google_id IN (SELECT value FROM json_each(?))`,
  )
    .bind(userId, JSON.stringify(ids))
    .all<Pick<ItemRow, "google_id" | "source_id" | "kind" | "name" | "google_parent_id" | "file_id" | "google_version" | "state" | "error">>();
  const known = new Map(results.map((r) => [r.google_id, r]));

  const requeue: string[] = [];
  const renames: { id: string; name: string; fileId: string | null }[] = [];
  const added = new Map<string, GFile[]>(); // by source
  for (const f of files) {
    const item = known.get(f.id);
    if (item) {
      const edited = item.kind === "file" && (item.state === "done" || item.state === "error") && item.google_version !== versionOf(f);
      const restored = item.state === "skipped" && (item.error === MSG.trashedInGoogle || item.error === MSG.deletedInGoogle);
      if (edited || restored) requeue.push(f.id);
      // A synced folder's own name stays "Google Drive · <name>" (it has no parent item).
      if (item.name !== f.name && item.google_parent_id) renames.push({ id: f.id, name: f.name, fileId: item.file_id });
      continue;
    }
    const parent = f.parents?.map((p) => known.get(p)).find((p) => p?.kind === "folder" && p.state !== "skipped");
    if (parent) added.set(parent.source_id, [...(added.get(parent.source_id) ?? []), f]);
  }

  for (const [sourceId, list] of added) await insertItems(env, userId, sourceId, list);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  if (requeue.length) {
    stmts.push(
      env.DB.prepare(
        `UPDATE gsync_items SET state = 'pending', attempts = 0, retry_at = 0, error = NULL, updated_at = ?1
          WHERE user_id = ?2 AND google_id IN (SELECT value FROM json_each(?3))`,
      ).bind(now, userId, JSON.stringify(requeue)),
    );
  }
  if (renames.length) {
    const json = JSON.stringify(
      renames.map((r) => {
        const f = files.find((x) => x.id === r.id)!;
        return { id: r.id, name: r.name, fileId: r.fileId, familyName: f.mimeType === FOLDER_MIME ? cleanName(f.name) : familyName(f) };
      }),
    );
    stmts.push(
      env.DB.prepare(
        `UPDATE gsync_items SET name = (SELECT json_extract(value, '$.name') FROM json_each(?3) WHERE json_extract(value, '$.id') = google_id), updated_at = ?1
          WHERE user_id = ?2 AND google_id IN (SELECT json_extract(value, '$.id') FROM json_each(?3))`,
      ).bind(now, userId, json),
      env.DB.prepare(
        `UPDATE files SET name = (SELECT json_extract(value, '$.familyName') FROM json_each(?2) WHERE json_extract(value, '$.fileId') = files.id), updated_at = ?1
          WHERE id IN (SELECT json_extract(value, '$.fileId') FROM json_each(?2)) AND trashed_at IS NULL`,
      ).bind(now, json),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
}

// ---- Folders (discover what's inside) -----------------------------------------------------------

async function processFolders(env: Env, g: Drive, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT i.* FROM gsync_items i JOIN gsync_sources s ON s.id = i.source_id
      WHERE i.user_id = ? AND i.state = 'pending' AND i.kind = 'folder' AND i.retry_at <= ? AND s.status = 'active'
      LIMIT ?`,
  )
    .bind(userId, Date.now(), SYNC_LIMITS.folders)
    .all<ItemRow>();
  for (const item of results) {
    if (!g.canFetch) return;
    try {
      await processFolder(env, g, item);
    } catch (err) {
      if (err instanceof OutOfBudget) throw err;
      await failItem(env, item, err);
    }
  }
}

async function processFolder(env: Env, g: Drive, item: ItemRow) {
  let folderId = item.file_id;
  if (!folderId) {
    const parent = await env.DB.prepare("SELECT file_id FROM gsync_items WHERE user_id = ? AND google_id = ?")
      .bind(item.user_id, item.google_parent_id)
      .first<{ file_id: string | null }>();
    if (!(await aliveFolder(env, parent?.file_id ?? null))) return skip(env, item, MSG.parentRemoved);
    folderId = newId();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO files (id, owner_id, parent_id, name, is_folder, size, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)",
      ).bind(folderId, item.user_id, parent!.file_id, cleanName(item.name), now, now, item.user_id),
      env.DB.prepare("UPDATE gsync_items SET file_id = ?, updated_at = ? WHERE user_id = ? AND google_id = ?").bind(folderId, now, item.user_id, item.google_id),
    ]);
  } else if (!(await aliveFolder(env, folderId))) {
    return skip(env, item, MSG.removedHere);
  }

  const page = await g.json<{ nextPageToken?: string; files: GFile[] }>(
    `${API}/files?q=${encodeURIComponent(`'${item.google_id}' in parents and trashed = false`)}&pageSize=1000` +
      `&fields=${encodeURIComponent(`nextPageToken,files(${ITEM_FIELDS})`)}${item.page_token ? `&pageToken=${encodeURIComponent(item.page_token)}` : ""}`,
  );
  await insertItems(env, item.user_id, item.source_id, page.files, item.google_id);
  await setItem(env, item, page.nextPageToken ? { page_token: page.nextPageToken } : { state: "done", page_token: null, error: null, attempts: 0 });
}

// ---- Files (copy content) -----------------------------------------------------------------------

async function processFiles(env: Env, g: Drive, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT i.* FROM gsync_items i JOIN gsync_sources s ON s.id = i.source_id
      WHERE i.user_id = ? AND i.state = 'pending' AND i.kind = 'file' AND i.retry_at <= ? AND s.status = 'active'
      ORDER BY i.mpu_id IS NULL, i.updated_at
      LIMIT ?`,
  )
    .bind(userId, Date.now(), SYNC_LIMITS.files)
    .all<ItemRow>();
  for (const item of results) {
    if (!g.canFetch) return;
    try {
      await processFile(env, g, item);
    } catch (err) {
      if (err instanceof OutOfBudget) throw err;
      await failItem(env, item, err);
    }
  }
}

async function processFile(env: Env, g: Drive, item: ItemRow) {
  let meta: GFileFull;
  try {
    meta = await g.json<GFileFull>(
      `${API}/files/${item.google_id}?fields=${encodeURIComponent(
        `${ITEM_FIELDS},thumbnailLink,exportLinks,imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis)`,
      )}`,
    );
  } catch (err) {
    if (err instanceof GoogleError && err.status === 404) return skip(env, item, MSG.deletedInGoogle);
    throw err;
  }
  if (meta.trashed) return skip(env, item, MSG.trashedInGoogle);
  const kind = classify(meta);
  if (kind.state === "skipped") return skip(env, item, kind.error!);
  if (await env.DB.prepare("SELECT 1 FROM google_links WHERE google_file_id = ? LIMIT 1").bind(meta.id).first()) return skip(env, item, MSG.madeByUs);

  const version = versionOf(meta);
  let existing: { id: string } | null = null;
  if (item.file_id) {
    existing = await env.DB.prepare("SELECT id FROM files WHERE id = ? AND trashed_at IS NULL").bind(item.file_id).first<{ id: string }>();
    if (!existing) return skip(env, item, MSG.removedHere);
    if (item.google_version === version && !item.mpu_id) return setItem(env, item, { state: "done", error: null, attempts: 0 });
  }
  let parentId: string | null = null;
  if (!existing) {
    const parent = await env.DB.prepare("SELECT file_id FROM gsync_items WHERE user_id = ? AND google_id = ?")
      .bind(item.user_id, item.google_parent_id)
      .first<{ file_id: string | null }>();
    if (!(await aliveFolder(env, parent?.file_id ?? null))) return skip(env, item, MSG.parentRemoved);
    parentId = parent!.file_id;
  }

  const native = NATIVE[meta.mimeType];
  const mime = native?.mime ?? (meta.mimeType || "application/octet-stream");
  let size = Number(meta.size ?? 0);
  if (!native && !(await hasRoom(env, item.user_id, size))) return pauseForStorage(env, item);

  // Resume an unfinished multipart upload only if Google still has the same version; otherwise start over.
  const mpu = item.mpu_id ? (JSON.parse(item.mpu_parts ?? "{}") as { v?: string | null; parts?: R2UploadedPart[] }) : null;
  if (item.mpu_id && mpu?.v !== version) {
    await env.BUCKET.resumeMultipartUpload(item.mpu_key!, item.mpu_id).abort().catch(() => {});
    await setItem(env, item, { mpu_id: null, mpu_key: null, mpu_version_id: null, mpu_parts: null, mpu_offset: 0 });
    item = { ...item, mpu_id: null, mpu_key: null, mpu_version_id: null, mpu_parts: null, mpu_offset: 0 };
  }
  const fileId = existing?.id ?? item.mpu_key?.split("/")[1] ?? newId();
  const versionId = item.mpu_version_id ?? newId();
  const key = item.mpu_key ?? fileKey(fileId, versionId);
  const httpMetadata = { contentType: mime };

  if (native) {
    const url = meta.exportLinks?.[native.mime];
    if (!url) return skip(env, item, "Google can't export this file");
    const bytes = await (await g.fetch(url)).arrayBuffer();
    size = bytes.byteLength;
    if (!(await hasRoom(env, item.user_id, size))) return pauseForStorage(env, item);
    await env.BUCKET.put(key, bytes, { httpMetadata });
  } else if (size <= SYNC_LIMITS.partSize) {
    const res = await g.fetch(`${API}/files/${meta.id}?alt=media`);
    await env.BUCKET.put(key, size === 0 ? "" : res.body!.pipeThrough(new FixedLengthStream(size)), { httpMetadata });
  } else {
    // Large file: one ranged download per part (100 MB), resumable across runs.
    const upload = item.mpu_id ? env.BUCKET.resumeMultipartUpload(key, item.mpu_id) : await env.BUCKET.createMultipartUpload(key, { httpMetadata });
    const parts = mpu?.parts ?? [];
    let offset = item.mpu_offset;
    if (!item.mpu_id) await setItem(env, item, { mpu_id: upload.uploadId, mpu_key: key, mpu_version_id: versionId, mpu_parts: JSON.stringify({ v: version, parts }), mpu_offset: 0 });
    while (offset < size) {
      if (!g.canFetch) return; // continue next run
      const len = Math.min(SYNC_LIMITS.partSize, size - offset);
      const res = await g.fetch(`${API}/files/${meta.id}?alt=media`, { headers: { range: `bytes=${offset}-${offset + len - 1}` } });
      parts.push(await upload.uploadPart(parts.length + 1, res.body!.pipeThrough(new FixedLengthStream(len))));
      offset += len;
      await setItem(env, item, { mpu_parts: JSON.stringify({ v: version, parts }), mpu_offset: offset });
    }
    await upload.complete(parts);
  }

  // Thumbnail from Google (best effort; the link is short-lived so it's fetched now).
  let thumb: string | null = null;
  if (meta.thumbnailLink && g.canFetch) {
    try {
      const t = await g.fetch(meta.thumbnailLink);
      thumb = thumbKey(fileId);
      await env.BUCKET.put(thumb, await t.arrayBuffer(), { httpMetadata: { contentType: t.headers.get("content-type") ?? "image/jpeg" } });
    } catch (err) {
      thumb = null;
      if (!(err instanceof OutOfBudget)) console.warn("gsync thumbnail failed", meta.id, err);
    }
  }

  const media = meta.videoMediaMetadata ?? meta.imageMediaMetadata;
  const width = media?.width ?? null;
  const height = media?.height ?? null;
  const duration = meta.videoMediaMetadata?.durationMillis ? Math.round(Number(meta.videoMediaMetadata.durationMillis) / 1000) : null;
  const name = familyName(meta);
  const now = Date.now();
  await env.DB.batch([
    existing
      ? env.DB.prepare(
          `UPDATE files SET current_version_id = ?, size = ?, mime = ?, name = ?, thumb_key = COALESCE(?, thumb_key), width = ?, height = ?, duration = ?,
                  updated_at = ?, updated_by = ? WHERE id = ?`,
        ).bind(versionId, size, mime, name, thumb, width, height, duration, now, item.user_id, fileId)
      : env.DB.prepare(
          `INSERT INTO files (id, owner_id, parent_id, name, is_folder, mime, size, current_version_id, thumb_key, width, height, duration, created_at, updated_at, updated_by)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(fileId, item.user_id, parentId, name, mime, size, versionId, thumb, width, height, duration, now, now, item.user_id),
    env.DB.prepare(
      "INSERT INTO file_versions (id, file_id, r2_key, size, mime, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'google_sync', ?, ?)",
    ).bind(versionId, fileId, key, size, mime, item.user_id, now),
    env.DB.prepare("UPDATE users SET storage_used = storage_used + ? WHERE id = ?").bind(size, item.user_id),
    env.DB.prepare(
      `UPDATE gsync_items SET state = 'done', file_id = ?, google_version = ?, size = ?, name = ?, error = NULL, attempts = 0, retry_at = 0,
              mpu_id = NULL, mpu_key = NULL, mpu_version_id = NULL, mpu_parts = NULL, mpu_offset = 0, updated_at = ?
        WHERE user_id = ? AND google_id = ?`,
    ).bind(fileId, version, size, meta.name, now, item.user_id, item.google_id),
  ]);
}

async function pauseForStorage(env: Env, item: ItemRow) {
  await env.DB.prepare("UPDATE gsync_sources SET status = 'paused', status_message = ? WHERE id = ?").bind(MSG.storageFull, item.source_id).run();
}

/** Mark sources with nothing left to do as synced, and tell the person when a first copy finishes. */
async function finishSources(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.name, s.dest_folder_id, s.first_sync_done_at,
            (SELECT COUNT(*) FROM gsync_items i WHERE i.source_id = s.id AND i.state = 'pending') AS pending,
            (SELECT COUNT(*) FROM gsync_items i WHERE i.source_id = s.id AND i.state = 'done' AND i.kind = 'file') AS done
       FROM gsync_sources s WHERE s.user_id = ? AND s.status = 'active'`,
  )
    .bind(userId)
    .all<{ id: string; name: string; dest_folder_id: string; first_sync_done_at: number | null; pending: number; done: number }>();
  const now = Date.now();
  for (const s of results) {
    if (s.pending) continue;
    await env.DB.prepare("UPDATE gsync_sources SET last_synced_at = ?, first_sync_done_at = COALESCE(first_sync_done_at, ?) WHERE id = ?")
      .bind(now, now, s.id)
      .run();
    if (!s.first_sync_done_at) {
      await notify(env, { userId, type: "gsync_done", fileId: s.dest_folder_id, payload: { folderName: s.name, count: s.done } });
    }
  }
}
