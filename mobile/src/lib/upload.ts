import { useSyncExternalStore } from "react";
import { File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { createVideoPlayer } from "expo-video";
import type { DriveFile } from "@shared/types";
import { api, authHeaders } from "./api";
import { API_URL } from "./config";

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

/** What the pickers hand us. Width/height/duration come from the picker when it knows them. */
export interface UploadSource {
  uri: string;
  name: string;
  size: number;
  mime?: string;
  width?: number;
  height?: number;
  duration?: number;
}

type Task = UploadItem & { source: UploadSource; parentId: string | null; abort: AbortController; uploadId?: string };

const FILE_CONCURRENCY = 2;
const MAX_RETRIES = 4;
const THUMB_MAX = 480;

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

/** PUT a file's bytes natively (streamed from disk, with progress) and parse the JSON reply. */
async function putFile<T>(file: File, path: string, contentType: string, signal: AbortSignal, onProgress?: (sent: number) => void): Promise<T> {
  const res = await file.upload(`${API_URL}/api${path}`, {
    httpMethod: "PUT",
    headers: { ...authHeaders(), "content-type": contentType },
    signal,
    onProgress: onProgress && (({ bytesSent }) => onProgress(bytesSent)),
  });
  if (res.status < 200 || res.status >= 300) {
    let message = `Upload failed (${res.status})`;
    try {
      message = JSON.parse(res.body).error ?? message;
    } catch {}
    throw new Error(message);
  }
  return JSON.parse(res.body) as T;
}

/**
 * Upload part `i`. Small files go up in one native request. Larger ones are sliced into a temp file per part,
 * because the native uploader sends whole files.
 */
async function uploadPart(t: Task, i: number, partSize: number, partCount: number, onProgress: (sent: number) => void) {
  const path = `/uploads/${t.uploadId}/parts/${i + 1}`;
  const src = new File(t.source.uri);
  if (partCount === 1) return putFile<{ partNumber: number; etag: string }>(src, path, "application/octet-stream", t.abort.signal, onProgress);

  const tmp = new File(Paths.cache, `upload-${t.id}-${i + 1}.part`);
  const handle = src.open();
  try {
    handle.offset = i * partSize;
    if (tmp.exists) tmp.delete();
    tmp.create();
    tmp.write(handle.readBytes(Math.min(partSize, t.size - i * partSize)));
  } finally {
    handle.close();
  }
  try {
    return await putFile<{ partNumber: number; etag: string }>(tmp, path, "application/octet-stream", t.abort.signal, onProgress);
  } finally {
    if (tmp.exists) tmp.delete();
  }
}

/** Thumbnails can only be taken once the player has loaded the video. */
function waitUntilReady(player: ReturnType<typeof createVideoPlayer>) {
  return new Promise<void>((resolve, reject) => {
    if (player.status === "readyToPlay") return resolve();
    const timer = setTimeout(() => (sub.remove(), reject(new Error("Video took too long to load"))), 15_000);
    const sub = player.addListener("statusChange", ({ status }) => {
      if (status === "readyToPlay" || status === "error") {
        clearTimeout(timer);
        sub.remove();
        if (status === "readyToPlay") resolve();
        else reject(new Error("Video could not be read"));
      }
    });
  });
}

/** Best-effort small webp thumbnail so the drive shows a preview on the web and in the app. Never throws. */
async function makeThumbnail(s: UploadSource): Promise<File | null> {
  try {
    const mime = s.mime ?? "";
    let source: Parameters<typeof ImageManipulator.manipulate>[0];
    if (mime.startsWith("image/") && mime !== "image/svg+xml") {
      source = s.uri;
    } else if (mime.startsWith("video/")) {
      const player = createVideoPlayer(s.uri);
      try {
        await waitUntilReady(player);
        [source] = await player.generateThumbnailsAsync(Math.min(1, (s.duration ?? 0) / 10), { maxWidth: THUMB_MAX, maxHeight: THUMB_MAX });
      } finally {
        player.release();
      }
    } else {
      return null;
    }
    const ctx = ImageManipulator.manipulate(source);
    const probe = await ctx.renderAsync();
    const scale = Math.min(1, THUMB_MAX / Math.max(probe.width, probe.height));
    const img = scale < 1 ? await ctx.resize({ width: Math.round(probe.width * scale), height: null }).renderAsync() : probe;
    const saved = await img.saveAsync({ format: SaveFormat.WEBP, compress: 0.8 });
    return new File(saved.uri);
  } catch (err) {
    console.warn("thumbnail failed", s.name, err);
    return null;
  }
}

async function run(t: Task) {
  t.status = "uploading";
  emit();
  const thumbPromise = makeThumbnail(t.source);
  const start = await api<{ uploadId: string; fileId: string; partSize: number; partCount: number }>("/uploads", {
    body: { name: t.name, size: t.size, mime: t.source.mime, parentId: t.parentId },
    signal: t.abort.signal,
  });
  t.uploadId = start.uploadId;

  // Parts go one at a time: each large part is buffered through a temp file, so this bounds disk and memory use.
  const parts: { partNumber: number; etag: string }[] = [];
  for (let i = 0; i < start.partCount; i++) {
    const done = i * start.partSize;
    for (let attempt = 0; ; attempt++) {
      try {
        parts.push(
          await uploadPart(t, i, start.partSize, start.partCount, (sent) => {
            t.loaded = done + sent;
            emit();
          }),
        );
        break;
      } catch (err) {
        if (t.abort.signal.aborted || attempt >= MAX_RETRIES) throw err;
        t.loaded = done;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }

  const file = await api<DriveFile>(`/uploads/${start.uploadId}/complete`, {
    body: { parts, width: t.source.width, height: t.source.height, duration: t.source.duration },
  });
  const thumb = await thumbPromise;
  if (thumb) {
    await putFile(thumb, `/files/${file.id}/thumbnail`, "image/webp", t.abort.signal)
      .then(() => (file.hasThumbnail = true))
      .catch(() => {});
    if (thumb.exists) thumb.delete();
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

let seq = 0;

export function enqueue(sources: UploadSource[], parentId: string | null) {
  for (const source of sources) {
    tasks.push({
      id: `${Date.now()}-${seq++}`,
      name: source.name,
      size: source.size,
      loaded: 0,
      status: "queued",
      source,
      parentId,
      abort: new AbortController(),
    });
  }
  emit();
  pump();
}
