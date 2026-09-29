/**
 * One-way Google Drive → Family Drive sync.
 *
 * Someone picks Google folders to sync (a "source"). Every folder/file inside becomes a row in gsync_items:
 * folders are listed to discover their children, files are streamed from Google into R2. After the first copy,
 * the Drive Changes API tells us about new, edited and renamed files. Deletions in Google are ignored on purpose,
 * and anything removed in Family Drive is never re-added.
 *
 * Built to stay inside Cloudflare's free limits:
 * - Work runs in small batches (cron every minute, plus right after adding a folder or "Sync now"): Workers Free allows
 *   ~50 outgoing requests and ~50 D1 queries per invocation. Unfinished work (even a large file's upload) continues next run.
 * - Idle minutes cost two indexed lookups; people with nothing to do are skipped before any token refresh or write.
 * - Every query is an index seek (never a scan of all items), and progress comes from counters on gsync_sources.
 * - Estimated D1 writes per day are capped (SYNC_LIMITS.dailyWrites) so a big first copy can't use up the
 *   whole app's daily write allowance (100k rows/day on the free plan); it just continues the next day.
 */
import { decrypt, encrypt, newId } from "./crypto";
import { driveAccessToken, hasScope, DRIVE_READONLY_SCOPE } from "./google";
import { fileKey, thumbKey } from "./storage";
import { notify } from "./notify";
import { cleanName, quotaFor } from "../routes/files";

/**
 * Google Drive sync is switched off for now (no API routes, no background runs). To bring it back, set this to true
 * together with GOOGLE_SYNC_ENABLED in web/lib/features.ts and re-add the "* * * * *" cron in wrangler.jsonc.
 */
export const GSYNC_ENABLED = false;

/** Limits sized for the free plans. On Workers Paid + D1 paid these can be raised a lot (1000 requests/queries per run). */
export const SYNC_LIMITS = {
  fetches: 40, // Google requests per run (Workers Free: 50 subrequests per invocation)
  files: 3, // files per run: ~9 D1 queries each (Workers Free: 50 D1 queries per invocation)
  folders: 3, // folder listings per run (a run does folders or files, not both)
  listPageSize: 500, // Google items per listing page (keeps each run's CPU time small)
  changesEveryMs: 5 * 60_000,
  partSize: 100 * 1024 * 1024,
  dailyWrites: 50_000, // estimated D1 rows written per UTC day by sync (half of the free plan's 100k)
};
// Estimated D1 rows written, measured against D1's rows_written and rounded up so the daily cap errs on the safe side.
const WRITES_PER_FILE = 18; // files + indexes + search index + version + usage + item + counters
const WRITES_PER_ITEM = 3; // a discovered item: row + indexes
const WRITES_PER_RUN = 4; // lease, token cache, changes cursor, daily tally

const API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MAX_ATTEMPTS = 5;
const LEASE_MS = 10 * 60_000;
const TOKEN_TTL_MS = 50 * 60_000; // Google access tokens last an hour
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

// ---- Google API with a per-run budget -----------------------------------------------------------

/** fetches/deadline: this run. writes: estimated D1 rows sync may still write today. */
export type Budget = { fetches: number; deadline: number; writes: number };
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

// Progress counters on gsync_sources, adjusted in the same batch as each item's state change.
type Counts = Partial<Record<"n_pending" | "n_done" | "n_skipped" | "n_error" | "bytes_done" | "folders_pending", number>>;

function bump(env: Env, sourceId: string, d: Counts) {
  const cols = Object.entries(d).filter(([, v]) => v);
  if (!cols.length) return null;
  return env.DB.prepare(`UPDATE gsync_sources SET ${cols.map(([k], i) => `${k} = ${k} + ?${i + 2}`).join(", ")} WHERE id = ?1`).bind(
    sourceId,
    ...cols.map(([, v]) => v),
  );
}

/** Counter change for an item leaving "pending" for another state. */
function leavePending(item: Pick<ItemRow, "kind">, to: "done" | "skipped" | "error", bytes = 0): Counts {
  const from: Counts = item.kind === "folder" ? { folders_pending: -1 } : { n_pending: -1 };
  if (to === "error") return { ...from, n_error: 1 };
  if (item.kind === "folder") return from;
  return to === "done" ? { ...from, n_done: 1, bytes_done: bytes } : { ...from, n_skipped: 1 };
}

const itemUpdate = (env: Env, item: Pick<ItemRow, "user_id" | "google_id">, fields: Record<string, unknown>) => {
  const cols = Object.keys(fields);
  return env.DB.prepare(
    `UPDATE gsync_items SET ${cols.map((k, i) => `${k} = ?${i + 3}`).join(", ")}, updated_at = ?${cols.length + 3} WHERE user_id = ?1 AND google_id = ?2`,
  ).bind(item.user_id, item.google_id, ...Object.values(fields), Date.now());
};

/** Update an item and its source's counters together. */
async function transition(env: Env, item: ItemRow, fields: Record<string, unknown>, counts: Counts = {}) {
  const b = bump(env, item.source_id, counts);
  await env.DB.batch(b ? [itemUpdate(env, item, fields), b] : [itemUpdate(env, item, fields)]);
}

const skip = (env: Env, item: ItemRow, reason: string) =>
  transition(env, item, { state: "skipped", error: reason, page_token: null }, leavePending(item, "skipped"));

/** A failed item is retried with backoff (2, 4, 8, 16 min) and then marked as an error the person can see and retry. */
async function failItem(env: Env, item: ItemRow, err: unknown) {
  const attempts = item.attempts + 1;
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  console.warn("gsync item failed", item.google_id, message);
  if (attempts >= MAX_ATTEMPTS) await transition(env, item, { state: "error", error: message, attempts }, leavePending(item, "error"));
  else await transition(env, item, { error: message, attempts, retry_at: Date.now() + 2 ** attempts * 60_000 });
}

/** Track new Google items with one statement (json_each), then count what was actually added. Known items are left alone. */
export async function insertItems(env: Env, userId: string, sourceId: string, files: GFile[], parentId?: string) {
  if (!files.length) return;
  const rows = files.map((f) => {
    const c = classify(f);
    return { id: f.id, name: f.name, kind: c.kind, parent: parentId ?? f.parents?.[0] ?? null, size: Number(f.size ?? 0), state: c.state, error: c.error };
  });
  const { results } = await env.DB.prepare(
    `INSERT OR IGNORE INTO gsync_items (user_id, google_id, source_id, kind, name, google_parent_id, size, state, error, updated_at)
     SELECT ?1, json_extract(value, '$.id'), ?2, json_extract(value, '$.kind'), json_extract(value, '$.name'), json_extract(value, '$.parent'),
            json_extract(value, '$.size'), json_extract(value, '$.state'), json_extract(value, '$.error'), ?3
       FROM json_each(?4)
     RETURNING kind, state`,
  )
    .bind(userId, sourceId, Date.now(), JSON.stringify(rows))
    .all<{ kind: string; state: string }>();
  const n = (kind: string, state: string) => results.filter((r) => r.kind === kind && r.state === state).length;
  const b = bump(env, sourceId, { folders_pending: n("folder", "pending"), n_pending: n("file", "pending"), n_skipped: n("file", "skipped") });
  if (b) await b.run();
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

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---- Run ----------------------------------------------------------------------------------------

/** Process sync work for everyone with an active source (or just one person), within one invocation's limits. */
export async function runSync(env: Env, opts: { userId?: string; force?: boolean; ms?: number } = {}) {
  const now = Date.now();
  const day = utcDay(now);
  const used = (await env.DB.prepare("SELECT writes FROM gsync_daily WHERE day = ?").bind(day).first<{ writes: number }>())?.writes ?? 0;
  const budget: Budget = { fetches: SYNC_LIMITS.fetches, deadline: now + (opts.ms ?? 25_000), writes: SYNC_LIMITS.dailyWrites - used };
  const startWrites = budget.writes;

  // Who has something to do? Index seeks only, so an idle minute costs almost nothing.
  const { results } = await env.DB.prepare(
    `SELECT s.user_id, COALESCE(MAX(u.changes_checked_at), 0) AS checked,
            MAX(EXISTS (SELECT 1 FROM gsync_items i WHERE i.source_id = s.id AND i.state = 'pending' AND i.kind = 'folder' AND i.retry_at <= ?1)
             OR EXISTS (SELECT 1 FROM gsync_items i WHERE i.source_id = s.id AND i.state = 'pending' AND i.kind = 'file' AND i.retry_at <= ?1)) AS work
       FROM gsync_sources s LEFT JOIN gsync_users u ON u.user_id = s.user_id
      WHERE s.status = 'active'${opts.userId ? " AND s.user_id = ?2" : ""}
      GROUP BY s.user_id`,
  )
    .bind(now, ...(opts.userId ? [opts.userId] : []))
    .all<{ user_id: string; checked: number; work: number }>();
  const due = results
    .filter((r) => opts.force || (r.work && budget.writes > 0) || now - r.checked > SYNC_LIMITS.changesEveryMs)
    // Shuffle so one person's big first sync can't starve everyone else's.
    .sort(() => Math.random() - 0.5);

  try {
    for (const r of due) {
      if (budget.fetches < 3 || Date.now() > budget.deadline) break;
      await runUser(env, r.user_id, budget, !!opts.force);
    }
  } finally {
    const spent = startWrites - budget.writes;
    if (spent > 0) {
      await env.DB.prepare("INSERT INTO gsync_daily (day, writes) VALUES (?1, ?2) ON CONFLICT (day) DO UPDATE SET writes = writes + ?2")
        .bind(day, spent)
        .run();
    }
  }
}

type Lease = { changes_page_token: string | null; changes_checked_at: number; access_token_enc: string | null; access_token_expires: number };

async function runUser(env: Env, userId: string, budget: Budget, force: boolean) {
  const now = Date.now();
  // Lease the person so overlapping runs (cron + "Sync now") don't process the same items twice.
  const lease = await env.DB.prepare(
    `INSERT INTO gsync_users (user_id, locked_until) VALUES (?1, ?2)
     ON CONFLICT (user_id) DO UPDATE SET locked_until = ?2 WHERE gsync_users.locked_until < ?3
     RETURNING changes_page_token, changes_checked_at, access_token_enc, access_token_expires`,
  )
    .bind(userId, now + LEASE_MS, now)
    .first<Lease>();
  if (!lease) return;
  budget.writes -= WRITES_PER_RUN;

  try {
    const token = await accessToken(env, userId, lease, budget);
    if (!token) {
      await env.DB.prepare("UPDATE gsync_sources SET status = 'error', status_message = ? WHERE user_id = ? AND status = 'active'")
        .bind(MSG.reconnect, userId)
        .run();
      return;
    }
    const g = new Drive(token, budget);
    if (force || now - lease.changes_checked_at > SYNC_LIMITS.changesEveryMs) await pullChanges(env, g, userId, lease.changes_page_token);
    // Folders first (to discover the tree), files once there are none left. Never both, to stay under the per-run query limit.
    if (budget.writes > 0 && !(await processFolders(env, g, userId, budget))) await processFiles(env, g, userId, budget);
    await finishSources(env, userId);
  } catch (err) {
    if (err instanceof GoogleError && err.status === 401) {
      // The cached token stopped working (e.g. access was revoked): refresh it next run.
      await env.DB.prepare("UPDATE gsync_users SET access_token_enc = NULL, access_token_expires = 0 WHERE user_id = ?").bind(userId).run();
    } else if (!(err instanceof OutOfBudget)) console.error("gsync run failed", userId, err);
  } finally {
    await env.DB.prepare("UPDATE gsync_users SET locked_until = 0 WHERE user_id = ?").bind(userId).run();
  }
}

/** Reuse the access token for its hour instead of refreshing it every run. */
async function accessToken(env: Env, userId: string, lease: Lease, budget: Budget) {
  if (lease.access_token_enc && lease.access_token_expires > Date.now()) return decrypt(lease.access_token_enc, env.TOKEN_ENC_KEY);
  if (!(await hasScope(env, userId, DRIVE_READONLY_SCOPE))) return null;
  budget.fetches--;
  const token = await driveAccessToken(env, userId);
  if (token) {
    await env.DB.prepare("UPDATE gsync_users SET access_token_enc = ?, access_token_expires = ? WHERE user_id = ?")
      .bind(await encrypt(token, env.TOKEN_ENC_KEY), Date.now() + TOKEN_TTL_MS, userId)
      .run();
  }
  return token;
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
      `${API}/changes?pageToken=${encodeURIComponent(token)}&pageSize=${SYNC_LIMITS.listPageSize}&spaces=drive` +
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
    `SELECT google_id, source_id, kind, name, google_parent_id, file_id, google_version, size, state, error
       FROM gsync_items WHERE user_id = ? AND google_id IN (SELECT value FROM json_each(?))`,
  )
    .bind(userId, JSON.stringify(ids))
    .all<Pick<ItemRow, "google_id" | "source_id" | "kind" | "name" | "google_parent_id" | "file_id" | "google_version" | "size" | "state" | "error">>();
  const known = new Map(results.map((r) => [r.google_id, r]));

  const requeue: string[] = [];
  const counts = new Map<string, Required<Pick<Counts, "n_pending" | "n_done" | "n_skipped" | "n_error" | "bytes_done">>>();
  const count = (sourceId: string) => {
    if (!counts.has(sourceId)) counts.set(sourceId, { n_pending: 0, n_done: 0, n_skipped: 0, n_error: 0, bytes_done: 0 });
    return counts.get(sourceId)!;
  };
  const renames: { id: string; name: string; fileId: string | null; familyName: string }[] = [];
  const added = new Map<string, GFile[]>(); // by source
  for (const f of files) {
    const item = known.get(f.id);
    if (item) {
      const edited = item.kind === "file" && (item.state === "done" || item.state === "error") && item.google_version !== versionOf(f);
      const restored = item.state === "skipped" && (item.error === MSG.trashedInGoogle || item.error === MSG.deletedInGoogle);
      if (edited || restored) {
        requeue.push(f.id);
        const c = count(item.source_id);
        c.n_pending++;
        if (item.state === "done") (c.n_done--, (c.bytes_done -= item.size));
        else if (item.state === "error") c.n_error--;
        else c.n_skipped--;
      }
      // A synced folder's own name stays "Google Drive · <name>" (it has no parent item).
      if (item.name !== f.name && item.google_parent_id) {
        renames.push({ id: f.id, name: f.name, fileId: item.file_id, familyName: f.mimeType === FOLDER_MIME ? cleanName(f.name) : familyName(f) });
      }
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
    for (const [sourceId, c] of counts) {
      const b = bump(env, sourceId, c);
      if (b) stmts.push(b);
    }
  }
  if (renames.length) {
    const json = JSON.stringify(renames);
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

/** The next pending items of each active source, by index (never a scan of everything pending). */
async function nextItems(env: Env, userId: string, kind: "folder" | "file", limit: number) {
  const { results: sources } = await env.DB.prepare("SELECT id FROM gsync_sources WHERE user_id = ? AND status = 'active'")
    .bind(userId)
    .all<{ id: string }>();
  const items: ItemRow[] = [];
  for (const s of sources) {
    if (items.length >= limit) break;
    // An unfinished large-file upload goes first so it isn't left half-done.
    const partial =
      kind === "file"
        ? await env.DB.prepare("SELECT * FROM gsync_items WHERE source_id = ? AND mpu_id IS NOT NULL AND state = 'pending' LIMIT 1").bind(s.id).first<ItemRow>()
        : null;
    const { results } = await env.DB.prepare(
      "SELECT * FROM gsync_items WHERE source_id = ? AND state = 'pending' AND kind = ? AND retry_at <= ? LIMIT ?",
    )
      .bind(s.id, kind, Date.now(), limit - items.length)
      .all<ItemRow>();
    if (partial) items.push(partial);
    items.push(...results.filter((r) => r.google_id !== partial?.google_id));
  }
  return items.slice(0, limit);
}

/** Returns how many folders were worked on (0 = none pending, so files can go next). */
async function processFolders(env: Env, g: Drive, userId: string, budget: Budget) {
  const items = await nextItems(env, userId, "folder", SYNC_LIMITS.folders);
  for (const item of items) {
    if (!g.canFetch || budget.writes <= 0) break;
    try {
      await processFolder(env, g, item, budget);
    } catch (err) {
      if (err instanceof OutOfBudget || (err instanceof GoogleError && err.status === 401)) throw err;
      await failItem(env, item, err);
    }
  }
  return items.length;
}

async function processFolder(env: Env, g: Drive, item: ItemRow, budget: Budget) {
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
      itemUpdate(env, item, { file_id: folderId }),
    ]);
    budget.writes -= WRITES_PER_FILE;
  } else if (!(await aliveFolder(env, folderId))) {
    return skip(env, item, MSG.removedHere);
  }

  const page = await g.json<{ nextPageToken?: string; files: GFile[] }>(
    `${API}/files?q=${encodeURIComponent(`'${item.google_id}' in parents and trashed = false`)}&pageSize=${SYNC_LIMITS.listPageSize}` +
      `&fields=${encodeURIComponent(`nextPageToken,files(${ITEM_FIELDS})`)}${item.page_token ? `&pageToken=${encodeURIComponent(item.page_token)}` : ""}`,
  );
  await insertItems(env, item.user_id, item.source_id, page.files, item.google_id);
  budget.writes -= WRITES_PER_ITEM * page.files.length;
  if (page.nextPageToken) await transition(env, item, { page_token: page.nextPageToken });
  else await transition(env, item, { state: "done", page_token: null, error: null, attempts: 0 }, leavePending(item, "done"));
}

// ---- Files (copy content) -----------------------------------------------------------------------

async function processFiles(env: Env, g: Drive, userId: string, budget: Budget) {
  for (const item of await nextItems(env, userId, "file", SYNC_LIMITS.files)) {
    if (!g.canFetch || budget.writes <= 0) return;
    try {
      await processFile(env, g, item, budget);
    } catch (err) {
      if (err instanceof OutOfBudget || (err instanceof GoogleError && err.status === 401)) throw err;
      await failItem(env, item, err);
    }
  }
}

async function processFile(env: Env, g: Drive, item: ItemRow, budget: Budget) {
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

  // One query: is this our own "Open with Google" copy, and does its Family Drive file / parent folder still exist?
  const ctx = (await env.DB.prepare(
    `SELECT EXISTS (SELECT 1 FROM google_links WHERE google_file_id = ?1) AS ours,
            (SELECT id FROM files WHERE id = ?2 AND trashed_at IS NULL) AS existing,
            (SELECT f.id FROM gsync_items p JOIN files f ON f.id = p.file_id
              WHERE p.user_id = ?3 AND p.google_id = ?4 AND f.is_folder = 1 AND f.trashed_at IS NULL) AS parent`,
  )
    .bind(meta.id, item.file_id, item.user_id, item.google_parent_id)
    .first<{ ours: number; existing: string | null; parent: string | null }>())!;
  if (ctx.ours) return skip(env, item, MSG.madeByUs);

  const version = versionOf(meta);
  const existing = ctx.existing;
  if (item.file_id) {
    if (!existing) return skip(env, item, MSG.removedHere);
    if (item.google_version === version && !item.mpu_id) {
      return transition(env, item, { state: "done", error: null, attempts: 0 }, leavePending(item, "done", item.size));
    }
  } else if (!ctx.parent) {
    return skip(env, item, MSG.parentRemoved);
  }

  const native = NATIVE[meta.mimeType];
  const mime = native?.mime ?? (meta.mimeType || "application/octet-stream");
  let size = Number(meta.size ?? 0);
  if (!native && !(await hasRoom(env, item.user_id, size))) return pauseForStorage(env, item);

  // Resume an unfinished multipart upload only if Google still has the same version; otherwise start over.
  const mpu = item.mpu_id ? (JSON.parse(item.mpu_parts ?? "{}") as { v?: string | null; parts?: R2UploadedPart[] }) : null;
  if (item.mpu_id && mpu?.v !== version) {
    await env.BUCKET.resumeMultipartUpload(item.mpu_key!, item.mpu_id).abort().catch(() => {});
    await itemUpdate(env, item, { mpu_id: null, mpu_key: null, mpu_version_id: null, mpu_parts: null, mpu_offset: 0 }).run();
    item = { ...item, mpu_id: null, mpu_key: null, mpu_version_id: null, mpu_parts: null, mpu_offset: 0 };
  }
  const fileId = existing ?? item.mpu_key?.split("/")[1] ?? newId();
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
    if (!item.mpu_id) {
      await itemUpdate(env, item, { mpu_id: upload.uploadId, mpu_key: key, mpu_version_id: versionId, mpu_parts: JSON.stringify({ v: version, parts }), mpu_offset: 0 }).run();
    }
    while (offset < size) {
      if (!g.canFetch) return; // continue next run
      const len = Math.min(SYNC_LIMITS.partSize, size - offset);
      const res = await g.fetch(`${API}/files/${meta.id}?alt=media`, { headers: { range: `bytes=${offset}-${offset + len - 1}` } });
      parts.push(await upload.uploadPart(parts.length + 1, res.body!.pipeThrough(new FixedLengthStream(len))));
      offset += len;
      await itemUpdate(env, item, { mpu_parts: JSON.stringify({ v: version, parts }), mpu_offset: offset }).run();
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
        ).bind(fileId, item.user_id, ctx.parent, name, mime, size, versionId, thumb, width, height, duration, now, now, item.user_id),
    env.DB.prepare(
      "INSERT INTO file_versions (id, file_id, r2_key, size, mime, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'google_sync', ?, ?)",
    ).bind(versionId, fileId, key, size, mime, item.user_id, now),
    env.DB.prepare("UPDATE users SET storage_used = storage_used + ? WHERE id = ?").bind(size, item.user_id),
    itemUpdate(env, item, {
      state: "done",
      file_id: fileId,
      google_version: version,
      size,
      name: meta.name,
      error: null,
      attempts: 0,
      retry_at: 0,
      mpu_id: null,
      mpu_key: null,
      mpu_version_id: null,
      mpu_parts: null,
      mpu_offset: 0,
    }),
    bump(env, item.source_id, leavePending(item, "done", size))!,
  ]);
  budget.writes -= WRITES_PER_FILE;
}

async function pauseForStorage(env: Env, item: ItemRow) {
  await env.DB.prepare("UPDATE gsync_sources SET status = 'paused', status_message = ? WHERE id = ?").bind(MSG.storageFull, item.source_id).run();
}

/** Tell the person when a folder's first copy finishes. Once that's happened this query matches nothing. */
async function finishSources(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, dest_folder_id, n_done FROM gsync_sources s
      WHERE user_id = ? AND status = 'active' AND first_sync_done_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM gsync_items i WHERE i.source_id = s.id AND i.state = 'pending')`,
  )
    .bind(userId)
    .all<{ id: string; dest_folder_id: string; n_done: number }>();
  for (const s of results) {
    await env.DB.prepare("UPDATE gsync_sources SET first_sync_done_at = ? WHERE id = ?").bind(Date.now(), s.id).run();
    await notify(env, { userId, type: "gsync_done", fileId: s.dest_folder_id, payload: { count: s.n_done } });
  }
}

/** Daily: correct any drift in the progress counters, and forget old daily write tallies. */
export async function gsyncHousekeeping(env: Env) {
  const n = (where: string) => `(SELECT COUNT(*) FROM gsync_items i WHERE i.source_id = gsync_sources.id AND ${where})`;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE gsync_sources SET
         n_pending = ${n("i.state = 'pending' AND i.kind = 'file'")},
         n_done = ${n("i.state = 'done' AND i.kind = 'file'")},
         n_skipped = ${n("i.state = 'skipped' AND i.kind = 'file'")},
         n_error = ${n("i.state = 'error'")},
         folders_pending = ${n("i.state = 'pending' AND i.kind = 'folder'")},
         bytes_done = (SELECT COALESCE(SUM(size), 0) FROM gsync_items i WHERE i.source_id = gsync_sources.id AND i.state = 'done' AND i.kind = 'file')`,
    ),
    env.DB.prepare("DELETE FROM gsync_daily WHERE day < ?").bind(utcDay(Date.now() - 7 * 86_400_000)),
  ]);
}

/** Whether sync has used up today's write allowance (shown on the sync page). */
export async function dailyLimitReached(env: Env) {
  const row = await env.DB.prepare("SELECT writes FROM gsync_daily WHERE day = ?").bind(utcDay(Date.now())).first<{ writes: number }>();
  return (row?.writes ?? 0) >= SYNC_LIMITS.dailyWrites;
}
