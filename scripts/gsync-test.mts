// End-to-end test of Google Drive sync against the local D1/R2 (wrangler getPlatformProxy) with a mocked Google Drive.
// Run from the project root after `wrangler d1 migrations apply family-drive-db --local`: npx tsx scripts/gsync-test.mts
// It uses the local owner test user (see scripts/smoke-test.mjs) and removes everything it creates.
import { createHash } from "node:crypto";
import { getPlatformProxy } from "wrangler";

const ROOT = process.argv[2] ?? process.cwd();
// Workers-only global used by the sync code.
(globalThis as any).FixedLengthStream = class extends TransformStream {
  constructor(_n: number) {
    super();
  }
};

const proxy = await getPlatformProxy<Env>({ configPath: `${ROOT}/wrangler.jsonc`, persist: true });
const { dispose } = proxy;
// In Node the R2 proxy can't take a streamed body (in Workers, FixedLengthStream makes it known-length), so buffer it here.
const buffered = async (v: unknown) => (v instanceof ReadableStream ? await new Response(v).arrayBuffer() : v);
const wrapUpload = (u: R2MultipartUpload) =>
  Object.assign(Object.create(u), { uploadId: u.uploadId, key: u.key, uploadPart: async (n: number, v: unknown) => u.uploadPart(n, (await buffered(v)) as ArrayBuffer), complete: (p: R2UploadedPart[]) => u.complete(p), abort: () => u.abort() });
const bucket = proxy.env.BUCKET;
// Count D1 queries and rows read per run (Workers Free: 50 queries per invocation; D1 bills rows read).
let queries = 0;
let rowsRead = 0;
const real = new WeakMap<object, D1PreparedStatement>();
const counted = (st: D1PreparedStatement): D1PreparedStatement => {
  const wrapped = {
    bind: (...a: unknown[]) => counted(st.bind(...a)),
    all: async () => {
      queries++;
      const r = await st.all();
      rowsRead += r.meta.rows_read ?? 0;
      return r;
    },
    run: async () => {
      queries++;
      const r = await st.run();
      rowsRead += r.meta.rows_read ?? 0;
      return r;
    },
    first: async (col?: string) => {
      queries++;
      const r = await st.all<Record<string, unknown>>();
      rowsRead += r.meta.rows_read ?? 0;
      const row = r.results[0] ?? null;
      return col ? (row?.[col] ?? null) : row;
    },
    raw: (...a: any[]) => (queries++, (st as any).raw(...a)),
  } as unknown as D1PreparedStatement;
  real.set(wrapped, st);
  return wrapped;
};
const db = proxy.env.DB;
const DB = {
  prepare: (q: string) => counted(db.prepare(q)),
  batch: async (list: D1PreparedStatement[]) => {
    queries += list.length;
    const r = await db.batch(list.map((x) => real.get(x) ?? x));
    for (const x of r) rowsRead += x.meta.rows_read ?? 0;
    return r;
  },
  exec: db.exec.bind(db),
  dump: () => db.dump(),
  withSession: db.withSession?.bind(db),
} as unknown as D1Database;
const env = {
  ...proxy.env,
  DB,
  BUCKET: Object.assign(Object.create(bucket), {
    get: bucket.get.bind(bucket),
    delete: bucket.delete.bind(bucket),
    put: async (k: string, v: unknown, o?: R2PutOptions) => bucket.put(k, (await buffered(v)) as ArrayBuffer, o),
    createMultipartUpload: async (k: string, o?: R2MultipartOptions) => wrapUpload(await bucket.createMultipartUpload(k, o)),
    resumeMultipartUpload: (k: string, id: string) => wrapUpload(bucket.resumeMultipartUpload(k, id)),
  }),
} as Env;
const { default: worker } = await import(`${ROOT}/src/worker/index.ts`);
const gs = await import(`${ROOT}/src/worker/lib/gsync.ts`);
const { encrypt } = await import(`${ROOT}/src/worker/lib/crypto.ts`);
const { purgeFiles } = await import(`${ROOT}/src/worker/lib/storage.ts`);

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) fails++;
};

// ---- Mock Google Drive ----------------------------------------------------------------------------
type MF = { id: string; name: string; mimeType: string; parents: string[]; trashed?: boolean; content?: Uint8Array; modifiedTime: string; appProperties?: Record<string, string> };
const drive = new Map<string, MF>();
const log: string[] = [];
let tick = 0;
const put = (f: Omit<MF, "modifiedTime">, silent = false) => {
  drive.set(f.id, { ...f, modifiedTime: new Date(1_800_000_000_000 + tick++ * 1000).toISOString() });
  if (!silent) log.push(f.id);
};
const bytes = (s: string) => new TextEncoder().encode(s);
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
const FOLDER = "application/vnd.google-apps.folder";
const DOC = "application/vnd.google-apps.document";
const meta = (f: MF) => ({
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  parents: f.parents,
  trashed: !!f.trashed,
  modifiedTime: f.modifiedTime,
  ...(f.content && !f.mimeType.startsWith("application/vnd.google-apps") ? { md5Checksum: md5(f.content), size: String(f.content.length) } : {}),
  ...(f.appProperties ? { appProperties: f.appProperties } : {}),
  ...(f.mimeType === DOC ? { exportLinks: { "application/vnd.openxmlformats-officedocument.wordprocessingml.document": `https://mock.google/export/${f.id}` } } : {}),
  ...(f.mimeType.startsWith("image/") ? { thumbnailLink: `https://mock.google/thumb/${f.id}`, imageMediaMetadata: { width: 40, height: 30 } } : {}),
});

let googleCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (url.host === "oauth2.googleapis.com") return json({ access_token: "at", expires_in: 3600, scope: "x" });
  if (url.host === "mock.google") {
    googleCalls++;
    const id = url.pathname.split("/").pop()!;
    if (url.pathname.startsWith("/thumb/")) return new Response(bytes("JPEGTHUMB"), { headers: { "content-type": "image/jpeg" } });
    return new Response(new Uint8Array([...bytes("DOCX:"), ...drive.get(id)!.content!]));
  }
  if (url.host !== "www.googleapis.com") return realFetch(input, init);
  googleCalls++;
  const path = url.pathname.replace("/drive/v3", "");
  if (path === "/changes/startPageToken") return json({ startPageToken: String(log.length) });
  if (path === "/changes") {
    const from = Number(url.searchParams.get("pageToken"));
    const slice = log.slice(from, from + 2); // tiny pages to exercise paging
    const next = from + slice.length;
    return json({
      changes: slice.map((id) => ({ fileId: id, removed: !drive.has(id), file: drive.has(id) ? meta(drive.get(id)!) : undefined })),
      ...(next < log.length ? { nextPageToken: String(next) } : { newStartPageToken: String(next) }),
    });
  }
  if (path === "/files") {
    const q = url.searchParams.get("q")!;
    const parent = /'([^']+)' in parents/.exec(q)?.[1]?.replace(/^root$/, "ROOT");
    let list = [...drive.values()].filter((f) => f.parents.includes(parent!) && !f.trashed);
    if (q.includes(`mimeType = '${FOLDER}'`)) list = list.filter((f) => f.mimeType === FOLDER);
    const from = Number(url.searchParams.get("pageToken") ?? 0);
    const page = list.slice(from, from + 2); // tiny pages to exercise folder paging
    return json({ files: page.map(meta), ...(from + 2 < list.length ? { nextPageToken: String(from + 2) } : {}) });
  }
  const id = path.split("/")[2] === "root" ? "ROOT" : path.split("/")[2];
  const f = drive.get(id);
  if (!f) return json({ error: { message: "File not found" } }, 404);
  if (url.searchParams.get("alt") === "media") {
    const range = new Headers(init?.headers).get("range");
    if (range) {
      const [a, b] = range.replace("bytes=", "").split("-").map(Number);
      return new Response(f.content!.slice(a, b + 1), { status: 206 });
    }
    return new Response(f.content!);
  }
  return json(meta(f));
}) as typeof fetch;

// ---- Fixtures -------------------------------------------------------------------------------------
const OWNER = "sid=devtoken-owner-123";
const owner = (await env.DB.prepare("SELECT u.id, u.storage_used FROM users u WHERE u.role = 'owner'").first<{ id: string; storage_used: number }>())!;
const savedToken = await env.DB.prepare("SELECT * FROM google_tokens WHERE user_id = ?").bind(owner.id).first();
await env.DB.prepare(
  "INSERT OR REPLACE INTO google_tokens (user_id, refresh_token_enc, scopes, updated_at) VALUES (?, ?, ?, ?)",
)
  .bind(owner.id, await encrypt("rt", env.TOKEN_ENC_KEY), "openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly", Date.now())
  .run();

await env.DB.batch([
  env.DB.prepare("DELETE FROM gsync_items WHERE user_id = ?").bind(owner.id),
  env.DB.prepare("DELETE FROM gsync_sources WHERE user_id = ?").bind(owner.id),
  env.DB.prepare("DELETE FROM gsync_users WHERE user_id = ?").bind(owner.id),
  env.DB.prepare("DELETE FROM gsync_daily"),
]);
const BIG = new Uint8Array(12 * 1024 * 1024).map((_, i) => i % 251);
put({ id: "ROOT", name: "My Drive", mimeType: FOLDER, parents: [] }, true);
put({ id: "PHOTOS", name: "Photos", mimeType: FOLDER, parents: ["ROOT"] }, true);
put({ id: "OTHER", name: "Other", mimeType: FOLDER, parents: ["ROOT"] }, true);
put({ id: "a", name: "a.jpg", mimeType: "image/jpeg", parents: ["PHOTOS"], content: bytes("AAA") }, true);
put({ id: "b", name: "b.jpg", mimeType: "image/jpeg", parents: ["PHOTOS"], content: bytes("BBBB") }, true);
put({ id: "c", name: "c.jpg", mimeType: "image/jpeg", parents: ["PHOTOS"], content: bytes("CCCCC") }, true);
put({ id: "SUB", name: "Sub", mimeType: FOLDER, parents: ["PHOTOS"] }, true);
put({ id: "d", name: "d.txt", mimeType: "text/plain", parents: ["SUB"], content: bytes("hello d") }, true);
put({ id: "notes", name: "Notes", mimeType: DOC, parents: ["PHOTOS"], content: bytes("doc body") }, true);
put({ id: "form", name: "Survey", mimeType: "application/vnd.google-apps.form", parents: ["PHOTOS"] }, true);
put({ id: "ours", name: "report", mimeType: DOC, parents: ["PHOTOS"], content: bytes("x"), appProperties: { familyDrive: "1" } }, true);
put({ id: "big", name: "big.mov", mimeType: "video/quicktime", parents: ["PHOTOS"], content: BIG }, true);
put({ id: "empty", name: "empty.txt", mimeType: "text/plain", parents: ["PHOTOS"], content: new Uint8Array(0) }, true);

const call = async (path: string, init: RequestInit = {}) => {
  const waits: Promise<unknown>[] = [];
  const res = await worker.fetch(
    new Request(`http://localhost${path}`, { ...init, headers: { cookie: OWNER, "content-type": "application/json", ...(init.headers ?? {}) } }),
    env,
    { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} },
  );
  await Promise.all(waits);
  return { status: res.status, body: await res.json().catch(() => null) };
};

gs.SYNC_LIMITS.partSize = 5 * 1024 * 1024;
gs.SYNC_LIMITS.changesEveryMs = 0;
gs.SYNC_LIMITS.fetches = 8; // small, so the big file must resume across runs
let maxCallsPerRun = 0;
let maxQueriesPerRun = 0;
let maxRowsPerRun = 0;
async function measuredRun(opts: { userId?: string; force?: boolean } = { userId: owner.id }) {
  googleCalls = 0;
  queries = 0;
  rowsRead = 0;
  await gs.runSync(env, opts);
  maxCallsPerRun = Math.max(maxCallsPerRun, googleCalls);
  maxQueriesPerRun = Math.max(maxQueriesPerRun, queries);
  maxRowsPerRun = Math.max(maxRowsPerRun, rowsRead);
  return { calls: googleCalls, queries, rows: rowsRead };
}
async function syncUntilIdle(max = 60) {
  for (let i = 0; i < max; i++) {
    await measuredRun();
    const p = await env.DB.prepare("SELECT COUNT(*) AS n FROM gsync_items i JOIN gsync_sources s ON s.id = i.source_id WHERE i.user_id = ? AND i.state = 'pending' AND s.status = 'active' AND i.retry_at <= ?")
      .bind(owner.id, Date.now())
      .first<{ n: number }>();
    if (!p!.n) return i + 1;
  }
  return -1;
}
const child = (parent: string, name: string) =>
  env.DB.prepare("SELECT * FROM files WHERE parent_id = ? AND name = ?").bind(parent, name).first<any>();
const content = async (fileId: string) => {
  const f = await env.DB.prepare("SELECT v.r2_key FROM files f JOIN file_versions v ON v.id = f.current_version_id WHERE f.id = ?").bind(fileId).first<{ r2_key: string }>();
  return new Uint8Array(await (await env.BUCKET.get(f!.r2_key))!.arrayBuffer());
};
async function countersMatch(label: string) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.n_pending, s.n_done, s.n_skipped, s.n_error, s.bytes_done, s.folders_pending,
            (SELECT COUNT(*) FROM gsync_items i WHERE i.source_id = s.id AND i.kind = 'file' AND i.state = 'pending') AS c_pending,
            (SELECT COUNT(*) FROM gsync_items i WHERE i.source_id = s.id AND i.kind = 'file' AND i.state = 'done') AS c_done,
            (SELECT COUNT(*) FROM gsync_items i WHERE i.source_id = s.id AND i.kind = 'file' AND i.state = 'skipped') AS c_skipped,
            (SELECT COUNT(*) FROM gsync_items i WHERE i.source_id = s.id AND i.state = 'error') AS c_error,
            (SELECT COALESCE(SUM(size), 0) FROM gsync_items i WHERE i.source_id = s.id AND i.kind = 'file' AND i.state = 'done') AS c_bytes,
            (SELECT COUNT(*) FROM gsync_items i WHERE i.source_id = s.id AND i.kind = 'folder' AND i.state = 'pending') AS c_folders
       FROM gsync_sources s WHERE s.user_id = ?`,
  )
    .bind(owner.id)
    .all<any>();
  const bad = results.filter(
    (r) => r.n_pending !== r.c_pending || r.n_done !== r.c_done || r.n_skipped !== r.c_skipped || r.n_error !== r.c_error || r.bytes_done !== r.c_bytes || r.folders_pending !== r.c_folders,
  );
  if (bad.length) console.log(JSON.stringify(bad));
  ok(!bad.length, `progress counters match a full recount (${label})`);
}
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

let sourceId = "";
let dest = "";
try {
  // 1. Not-a-folder and browse
  const browse = await call("/api/gsync/folders?parent=root");
  ok(browse.status === 200 && browse.body.folders.map((f: any) => f.name).join() === "Photos,Other", "browse lists Google folders only");
  ok((await call("/api/gsync/sources", { method: "POST", body: JSON.stringify({ googleFolderId: "a" }) })).status === 400, "can't sync a file as a folder");

  // 2. First sync
  const add = await call("/api/gsync/sources", { method: "POST", body: JSON.stringify({ googleFolderId: "PHOTOS" }) });
  ok(add.status === 201, "add source");
  sourceId = add.body.id;
  dest = add.body.destFolderId;
  const runs = await syncUntilIdle();
  ok((await call("/api/gsync/sources", { method: "POST", body: JSON.stringify({ googleFolderId: "SUB" }) })).status === 409, "a folder that's already syncing (nested) is rejected");
  ok(runs > 1, `first sync finished in ${runs} runs (resumes across runs)`);
  ok(maxCallsPerRun <= gs.SYNC_LIMITS.fetches, `never more than ${gs.SYNC_LIMITS.fetches} Google requests per run (max ${maxCallsPerRun})`);
  await countersMatch("after first copy");
  // Idle: nothing pending and changes checked just now → the cron minute is nearly free.
  gs.SYNC_LIMITS.changesEveryMs = 5 * 60_000;
  const idle = await measuredRun({});
  ok(idle.calls === 0 && idle.queries <= 3 && idle.rows <= 20, `idle minute: ${idle.queries} queries, ${idle.rows} rows read, ${idle.calls} Google calls`);
  gs.SYNC_LIMITS.changesEveryMs = 0;
  const check = await measuredRun({});
  ok(check.calls <= 2, `changes check with a cached token: ${check.calls} Google call(s), ${check.queries} queries, ${check.rows} rows`);

  const destRow = await env.DB.prepare("SELECT name, parent_id FROM files WHERE id = ?").bind(dest).first<any>();
  ok(destRow.name === "Google Drive · Photos" && destRow.parent_id === null, "destination folder in My Files");
  const a = await child(dest, "a.jpg");
  ok(a && eq(await content(a.id), bytes("AAA")), "a.jpg copied with content");
  ok(a?.thumb_key && a.width === 40 && a.height === 30, "thumbnail + dimensions saved");
  ok(await child(dest, "b.jpg"), "b.jpg copied (folder listing paged)");
  ok(await child(dest, "c.jpg"), "c.jpg copied");
  const sub = await child(dest, "Sub");
  ok(sub?.is_folder, "subfolder created");
  ok(sub && (await child(sub.id, "d.txt")), "file inside subfolder copied");
  const notes = await child(dest, "Notes.docx");
  ok(notes && new TextDecoder().decode(await content(notes.id)).startsWith("DOCX:"), "Google Doc exported as .docx");
  const big = await child(dest, "big.mov");
  ok(big && big.size === BIG.length && eq(await content(big.id), BIG), "12 MB file copied intact in parts");
  ok(await child(dest, "empty.txt"), "empty file copied");
  ok(!(await child(dest, "Survey")) && !(await child(dest, "report.docx")), "Google Form and our own Open-with copy skipped");
  const v = await env.DB.prepare("SELECT source FROM file_versions WHERE file_id = ?").bind(a.id).first<{ source: string }>();
  ok(v?.source === "google_sync", "version source is google_sync");
  const used = await env.DB.prepare("SELECT storage_used FROM users WHERE id = ?").bind(owner.id).first<{ storage_used: number }>();
  ok(used!.storage_used - owner.storage_used === 3 + 4 + 5 + 7 + (5 + 8) + BIG.length, "storage usage counted");

  const status = await call("/api/gsync");
  const s = status.body.sources.find((x: any) => x.id === sourceId);
  ok(status.body.connected && s.filesDone === 7 && s.filesSkipped === 2 && s.filesPending === 0 && s.lastSyncedAt, `progress: ${s.filesDone} done, ${s.filesSkipped} skipped`);
  const note = await env.DB.prepare("SELECT payload FROM notifications WHERE user_id = ? AND type = 'gsync_done' AND file_id = ?").bind(owner.id, dest).first<any>();
  ok(note && JSON.parse(note.payload).count === 7, "notification when the first copy finishes");

  // 3. Changes after the first copy
  put({ ...drive.get("a")!, content: bytes("AAA edited") });
  put({ ...drive.get("b")!, name: "b-renamed.jpg" });
  put({ id: "e", name: "e.jpg", mimeType: "image/jpeg", parents: ["SUB"], content: bytes("EEE") });
  put({ id: "SUB2", name: "New folder", mimeType: FOLDER, parents: ["PHOTOS"] });
  put({ id: "f", name: "f.txt", mimeType: "text/plain", parents: ["SUB2"], content: bytes("in new folder") });
  put({ id: "o", name: "o.jpg", mimeType: "image/jpeg", parents: ["OTHER"], content: bytes("elsewhere") });
  put({ ...drive.get("c")!, trashed: true });
  await syncUntilIdle();
  const a2 = await child(dest, "a.jpg");
  const versions = await env.DB.prepare("SELECT COUNT(*) AS n FROM file_versions WHERE file_id = ?").bind(a2.id).first<{ n: number }>();
  ok(eq(await content(a2.id), bytes("AAA edited")) && versions!.n === 2, "edited file becomes a new version");
  ok(await child(dest, "b-renamed.jpg"), "rename in Google renames here");
  ok(await child(sub.id, "e.jpg"), "new file in a synced subfolder is copied");
  const sub2 = await child(dest, "New folder");
  ok(sub2 && (await child(sub2.id, "f.txt")), "new folder (and its file) is copied");
  ok(!(await env.DB.prepare("SELECT 1 FROM gsync_items WHERE google_id = 'o'").first()), "changes outside synced folders are ignored");
  ok((await child(dest, "c.jpg"))?.trashed_at === null, "trashing in Google does not delete here");

  await countersMatch("after changes");

  // 4. Removed in Family Drive is never re-added
  const d = await child(sub.id, "d.txt");
  await env.DB.prepare("UPDATE files SET trashed_at = ? WHERE id = ?").bind(Date.now(), d.id).run();
  put({ ...drive.get("d")!, content: bytes("hello d v2") });
  await syncUntilIdle();
  const dItem = await env.DB.prepare("SELECT state, error FROM gsync_items WHERE google_id = 'd'").first<any>();
  const dCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE parent_id = ? AND name = 'd.txt'").bind(sub.id).first<{ n: number }>();
  ok(dItem.state === "skipped" && dItem.error === gs.MSG.removedHere && dCount!.n === 1, "file trashed here isn't re-added");

  // 5. Storage limit pauses, Resume continues
  const now = (await env.DB.prepare("SELECT storage_used FROM users WHERE id = ?").bind(owner.id).first<{ storage_used: number }>())!.storage_used;
  await env.DB.prepare("UPDATE users SET storage_quota = ? WHERE id = ?").bind(now + 1, owner.id).run();
  put({ id: "g", name: "g.jpg", mimeType: "image/jpeg", parents: ["PHOTOS"], content: bytes("GGGGGG") });
  await syncUntilIdle();
  const paused = await env.DB.prepare("SELECT status, status_message FROM gsync_sources WHERE id = ?").bind(sourceId).first<any>();
  ok(paused.status === "paused" && paused.status_message === gs.MSG.storageFull && !(await child(dest, "g.jpg")), "storage full pauses the sync");
  await env.DB.prepare("UPDATE users SET storage_quota = NULL WHERE id = ?").bind(owner.id).run();
  ok((await call(`/api/gsync/sources/${sourceId}/resume`, { method: "POST", body: "{}" })).status === 200, "resume");
  await syncUntilIdle();
  ok(await child(dest, "g.jpg"), "resumed sync copies the waiting file");

  await countersMatch("after storage pause/resume");

  // 5b. Daily write cap: work waits for tomorrow, the page says so, changes are still read
  const spent = (await env.DB.prepare("SELECT writes FROM gsync_daily WHERE day = ?").bind(new Date().toISOString().slice(0, 10)).first<{ writes: number }>())!.writes;
  ok(spent > 0, `today's estimated sync writes are tracked (${spent})`);
  const cap = gs.SYNC_LIMITS.dailyWrites;
  gs.SYNC_LIMITS.dailyWrites = spent;
  put({ id: "h", name: "h.jpg", mimeType: "image/jpeg", parents: ["PHOTOS"], content: bytes("HHH") });
  await measuredRun();
  await measuredRun();
  const limited = await call("/api/gsync");
  ok(limited.body.dailyLimitReached && !(await child(dest, "h.jpg")), "daily write cap pauses copying and the page shows it");
  ok(await env.DB.prepare("SELECT 1 FROM gsync_items WHERE google_id = 'h' AND state = 'pending'").first(), "…but the new file is already queued for tomorrow");
  gs.SYNC_LIMITS.dailyWrites = cap;
  await syncUntilIdle();
  ok(await child(dest, "h.jpg"), "copying continues once there's allowance again");
  ok(maxQueriesPerRun <= 50, `never more than 50 D1 queries per run (max ${maxQueriesPerRun})`);
  ok(maxRowsPerRun < 1000, `D1 rows read per run stay small (max ${maxRowsPerRun})`);

  // 6. Disconnect → error; stop syncing keeps files
  const other = await call(`/api/gsync/sources/${sourceId}/pause`, { method: "POST", body: "{}" });
  ok(other.status === 200, "pause");
  ok((await call(`/api/gsync/sources/${sourceId}`, { method: "DELETE" })).status === 200, "stop syncing");
  ok(!(await env.DB.prepare("SELECT 1 FROM gsync_items WHERE source_id = ?").bind(sourceId).first()) && (await child(dest, "a.jpg")), "stopping keeps copied files");
  sourceId = "";
} finally {
  // Clean up everything the test created.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM gsync_items WHERE user_id = ?").bind(owner.id),
    env.DB.prepare("DELETE FROM gsync_sources WHERE user_id = ?").bind(owner.id),
  ]);
  if (dest) {
    const { results } = await env.DB.prepare(
      "WITH RECURSIVE t(id) AS (SELECT ?1 UNION ALL SELECT f.id FROM files f JOIN t ON f.parent_id = t.id) SELECT id FROM t",
    )
      .bind(dest)
      .all<{ id: string }>();
    await purgeFiles(env, results.map((r) => r.id));
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM gsync_users WHERE user_id = ?").bind(owner.id),
    env.DB.prepare("DELETE FROM gsync_daily"),
    env.DB.prepare("DELETE FROM notifications WHERE user_id = ? AND type = 'gsync_done'").bind(owner.id),
    env.DB.prepare("UPDATE users SET storage_quota = NULL WHERE id = ?").bind(owner.id),
    savedToken
      ? env.DB.prepare("INSERT OR REPLACE INTO google_tokens (user_id, refresh_token_enc, scopes, updated_at) VALUES (?, ?, ?, ?)").bind(
          owner.id,
          (savedToken as any).refresh_token_enc,
          (savedToken as any).scopes,
          (savedToken as any).updated_at,
        )
      : env.DB.prepare("DELETE FROM google_tokens WHERE user_id = ?").bind(owner.id),
  ]);
  const after = await env.DB.prepare("SELECT storage_used FROM users WHERE id = ?").bind(owner.id).first<{ storage_used: number }>();
  console.log(`cleanup: storage back to ${after!.storage_used} (was ${owner.storage_used})`);
  await dispose();
}
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);
