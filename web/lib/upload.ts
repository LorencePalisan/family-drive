import { useSyncExternalStore } from "react";
import { api } from "./api";
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

type Task = UploadItem & { file: File; parentId: string | null; abort: AbortController; uploadId?: string };

const PART_CONCURRENCY = 4;
const FILE_CONCURRENCY = 2;
const MAX_RETRIES = 4;

let tasks: Task[] = [];
let snapshot: UploadItem[] = [];
const listeners = new Set<() => void>();
let onFinished: ((f: DriveFile) => void) | null = null;

function emit() {
  snapshot = tasks.map(({ id, name, size, loaded, status, error, fileId }) => ({ id, name, size, loaded, status, error, fileId }));
  listeners.forEach((l) => l());
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
  tasks = tasks.filter((t) => t.status === "queued" || t.status === "uploading");
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

export function retryUpload(id: string) {
  const t = tasks.find((x) => x.id === id);
  if (!t || (t.status !== "error" && t.status !== "cancelled")) return;
  Object.assign(t, { status: "queued", loaded: 0, error: undefined, uploadId: undefined, abort: new AbortController() });
  emit();
  pump();
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
  const infoPromise = mediaInfo(t.file);
  const start = await api<{ uploadId: string; fileId: string; partSize: number; partCount: number }>("/uploads", {
    body: { name: t.name, size: t.size, mime: t.file.type || undefined, parentId: t.parentId },
    signal: t.abort.signal,
  });
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
              emit();
            }),
          );
          progress[i] = blob.size;
          break;
        } catch (err) {
          if (t.abort.signal.aborted || attempt >= MAX_RETRIES) throw err;
          progress[i] = 0;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, start.partCount) }, worker));

  const info = await infoPromise;
  const file = await api<DriveFile>(`/uploads/${start.uploadId}/complete`, {
    body: { parts, width: info.width, height: info.height, duration: info.duration },
  });
  if (info.thumbnail) {
    await fetch(`/api/files/${file.id}/thumbnail`, { method: "PUT", headers: { "content-type": "image/webp" }, body: info.thumbnail }).catch(
      () => {},
    );
    file.hasThumbnail = true;
  }
  t.status = "done";
  t.loaded = t.size;
  t.fileId = file.id;
  emit();
  onFinished?.(file);
}

function pump() {
  const active = tasks.filter((t) => t.status === "uploading").length;
  for (const t of tasks.filter((x) => x.status === "queued").slice(0, Math.max(0, FILE_CONCURRENCY - active))) {
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

export function enqueue(files: { file: File; parentId: string | null }[]) {
  for (const { file, parentId } of files) {
    tasks.push({
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      loaded: 0,
      status: "queued",
      file,
      parentId,
      abort: new AbortController(),
    });
  }
  emit();
  pump();
}

/**
 * Upload files that may carry relative paths (folder upload / dropped folders).
 * Folders are created first, then each file is queued into its folder.
 */
export async function uploadWithPaths(items: { file: File; path: string }[], parentId: string | null) {
  const folderIds = new Map<string, string | null>([["", parentId]]);
  const ensureFolder = async (dir: string): Promise<string | null> => {
    if (folderIds.has(dir)) return folderIds.get(dir)!;
    const slash = dir.lastIndexOf("/");
    const parent = await ensureFolder(slash === -1 ? "" : dir.slice(0, slash));
    const created = await api<DriveFile>("/folders", { body: { name: dir.slice(slash + 1), parentId: parent } });
    folderIds.set(dir, created.id);
    return created.id;
  };
  const queued: { file: File; parentId: string | null }[] = [];
  for (const { file, path } of items) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    queued.push({ file, parentId: await ensureFolder(dir) });
  }
  enqueue(queued);
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
