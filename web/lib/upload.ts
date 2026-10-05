import { useSyncExternalStore } from "react";
import { api, ApiError } from "./api";
import { mediaInfo } from "./thumbs";
import type { DriveFile } from "./types";

export type UploadStatus = "queued" | "uploading" | "done" | "error" | "cancelled";

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  loaded: number;
  status: UploadStatus;
  error?: string;
  fileId?: string;
}

type Task = UploadItem & {
  file: File;
  parentId: string | null;
  /** Folder uploads: creates (or reuses) the file's folder when the file's turn comes. */
  resolveParent?: () => Promise<string | null>;
  abort: AbortController;
  uploadId?: string;
};

const PART_CONCURRENCY = 4;
// Small files are mostly round trips, so several run at once; big ones are bandwidth-bound, so only two.
const FILE_CONCURRENCY = 6;
const LARGE_FILE_CONCURRENCY = 2;
const LARGE_FILE = 50 * 1024 * 1024;
const MAX_RETRIES = 4;

let tasks: Task[] = [];
let snapshot: UploadItem[] = [];
const listeners = new Set<() => void>();
let onFinished: ((f: DriveFile) => void) | null = null;

let emitTimer: ReturnType<typeof setTimeout> | undefined;

function emit() {
  clearTimeout(emitTimer);
  emitTimer = undefined;
  snapshot = tasks.map(({ id, name, size, loaded, status, error, fileId }) => ({ id, name, size, loaded, status, error, fileId }));
  listeners.forEach((l) => l());
}

/** Progress ticks arrive many times a second per part; batch them so a big queue doesn't re-render constantly. */
function emitSoon() {
  emitTimer ??= setTimeout(emit, 200);
}

const isActive = (t: UploadItem) => t.status === "queued" || t.status === "uploading";

/** Uploaded files still waiting for their thumbnail (see addMediaInfo). */
let pendingMedia = 0;

// Closing the tab drops the queue (and thumbnails not yet made), so ask first while either is pending.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (pendingMedia > 0 || tasks.some(isActive)) e.preventDefault();
  });
}

export function useUploads() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => snapshot,
  );
}

/** Register a callback (e.g. query invalidation) for each finished upload. */
export function onUploadFinished(cb: (f: DriveFile) => void) {
  onFinished = cb;
}

export function clearFinished() {
  tasks = tasks.filter(isActive);
  emit();
}

export function cancelUpload(id: string) {
  const t = tasks.find((x) => x.id === id);
  if (!t || t.status === "done") return;
  t.abort.abort();
  t.status = "cancelled";
  if (t.uploadId) api(`/uploads/${t.uploadId}`, { method: "DELETE" }).catch(() => {});
  emit();
  pump();
}

export function cancelAll() {
  for (const t of tasks.filter(isActive)) {
    t.abort.abort();
    t.status = "cancelled";
    if (t.uploadId) api(`/uploads/${t.uploadId}`, { method: "DELETE" }).catch(() => {});
  }
  emit();
}

function requeue(t: Task) {
  if (t.status !== "error" && t.status !== "cancelled") return;
  Object.assign(t, { status: "queued", loaded: 0, error: undefined, uploadId: undefined, abort: new AbortController() });
}

export function retryUpload(id: string) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  requeue(t);
  emit();
  pump();
}

export function retryAllFailed() {
  tasks.filter((t) => t.status === "error").forEach(requeue);
  emit();
  pump();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry network errors, rate limits and server errors with backoff; a 4xx (quota, no access) fails at once. */
async function withRetry<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = !(err instanceof ApiError) || err.status === 429 || err.status >= 500;
      if (signal.aborted || !retryable || attempt >= MAX_RETRIES) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

/** PUT one part with progress, using XHR because fetch has no upload progress events. */
function putPart(url: string, blob: Blob, signal: AbortSignal, onProgress: (loaded: number) => void) {
  return new Promise<{ partNumber: number; etag: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(`Part failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

async function run(t: Task) {
  t.status = "uploading";
  emit();
  if (t.resolveParent) t.parentId = await t.resolveParent();
  const start = await withRetry(t.abort.signal, () =>
    api<{ uploadId: string; fileId: string; partSize: number; partCount: number }>("/uploads", {
      body: { name: t.name, size: t.size, mime: t.file.type || undefined, parentId: t.parentId },
      signal: t.abort.signal,
    }),
  );
  t.uploadId = start.uploadId;

  const progress = new Array<number>(start.partCount).fill(0);
  const parts: { partNumber: number; etag: string }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < start.partCount) {
      const i = next++;
      const blob = t.file.slice(i * start.partSize, Math.min(t.size, (i + 1) * start.partSize));
      for (let attempt = 0; ; attempt++) {
        try {
          parts.push(
            await putPart(`/api/uploads/${start.uploadId}/parts/${i + 1}`, blob, t.abort.signal, (loaded) => {
              progress[i] = loaded;
              t.loaded = progress.reduce((a, b) => a + b, 0);
              emitSoon();
            }),
          );
          progress[i] = blob.size;
          break;
        } catch (err) {
          if (t.abort.signal.aborted || attempt >= MAX_RETRIES) throw err;
          progress[i] = 0;
          await sleep(1000 * 2 ** attempt);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, start.partCount) }, worker));

  const file = await withRetry(t.abort.signal, () =>
    api<DriveFile>(`/uploads/${start.uploadId}/complete`, { body: { parts } }).catch((err) => {
      // A retry after a lost response finds the upload already completed; the file is there, so fetch it.
      if (err instanceof ApiError && err.status === 409) return api<DriveFile>(`/files/${start.fileId}`);
      throw err;
    }),
  );
  t.status = "done";
  t.loaded = t.size;
  t.fileId = file.id;
  emit();
  onFinished?.(file);
  addMediaInfo(file, t.file);
}

/**
 * Thumbnail, dimensions and duration are added after the upload is saved, so a slow decode (or a video in a
 * background tab, which Chrome won't load) never holds an upload slot. mediaInfo limits its own concurrency.
 */
async function addMediaInfo(file: DriveFile, blob: File) {
  pendingMedia++;
  try {
    const info = await mediaInfo(blob);
    if (!info.thumbnail) return;
    const q = new URLSearchParams();
    for (const k of ["width", "height", "duration"] as const) if (info[k]) q.set(k, String(info[k]));
    const res = await fetch(`/api/files/${file.id}/thumbnail?${q}`, { method: "PUT", headers: { "content-type": "image/webp" }, body: info.thumbnail }).catch(
      () => null,
    );
    if (res?.ok) onFinished?.({ ...file, hasThumbnail: true });
  } finally {
    pendingMedia--;
  }
}

function pump() {
  const running = tasks.filter((t) => t.status === "uploading");
  let active = running.length;
  let large = running.filter((t) => t.size > LARGE_FILE).length;
  for (const t of tasks) {
    if (active >= FILE_CONCURRENCY) break;
    if (t.status !== "queued" || (t.size > LARGE_FILE && large >= LARGE_FILE_CONCURRENCY)) continue;
    active++;
    if (t.size > LARGE_FILE) large++;
    run(t)
      .catch((err: Error) => {
        if (t.status === "cancelled") return;
        t.status = "error";
        t.error = err.message;
        emit();
      })
      .finally(pump);
  }
}

export function enqueue(files: { file: File; parentId: string | null; resolveParent?: () => Promise<string | null> }[]) {
  for (const { file, parentId, resolveParent } of files) {
    tasks.push({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      loaded: 0,
      status: "queued",
      file,
      parentId,
      resolveParent,
      abort: new AbortController(),
    });
  }
  emit();
  pump();
}

/**
 * Upload files that may carry relative paths (folder upload / dropped folders). Everything is queued at
 * once; each folder is created when the first file inside it starts, shared by its siblings, and retried
 * like any other step. A folder that can't be created fails just its own files, which Retry picks up again.
 */
export function uploadWithPaths(items: { file: File; path: string }[], parentId: string | null) {
  const folders = new Map<string, Promise<string | null>>([["", Promise.resolve(parentId)]]);
  const ensureFolder = (dir: string): Promise<string | null> => {
    let p = folders.get(dir);
    if (!p) {
      const slash = dir.lastIndexOf("/");
      p = ensureFolder(slash === -1 ? "" : dir.slice(0, slash)).then((parent) =>
        withRetry(new AbortController().signal, () => api<DriveFile>("/folders", { body: { name: dir.slice(slash + 1), parentId: parent } })).then(
          (f) => f.id,
        ),
      );
      folders.set(dir, p);
      // Forget a failure so retrying one of its files tries to create the folder again.
      p.catch(() => folders.delete(dir));
    }
    return p;
  };
  enqueue(
    items.map(({ file, path }) => {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      return { file, parentId, resolveParent: () => ensureFolder(dir) };
    }),
  );
}

/** Read files (including nested folders) from a drag-and-drop DataTransfer. */
export async function filesFromDrop(dt: DataTransfer): Promise<{ file: File; path: string }[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...dt.files].map((file) => ({ file, path: file.name }));
  const out: { file: File; path: string }[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}
