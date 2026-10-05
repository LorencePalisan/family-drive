const THUMB_MAX = 480;

export type MediaInfo = { width?: number; height?: number; duration?: number; thumbnail?: Blob };

function canvasToBlob(source: CanvasImageSource, w: number, h: number): Promise<Blob | null> {
  const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.8));
}

async function imageInfo(file: File): Promise<MediaInfo> {
  const bmp = await createImageBitmap(file); // respects EXIF orientation
  try {
    return { width: bmp.width, height: bmp.height, thumbnail: (await canvasToBlob(bmp, bmp.width, bmp.height)) ?? undefined };
  } finally {
    bmp.close();
  }
}

/** iPhone photos. Safari decodes HEIC itself; Chrome and Firefox can't, so they use libheif (WASM, in a worker), loaded on first use. */
export const isHeic = (file: { name: string; type?: string | null }) => /^image\/hei[cf]/.test(file.type ?? "") || /\.hei[cf]$/i.test(file.name);

/** A full-size JPEG of a HEIC image for browsers that can't show HEIC; Safari's own decoder is used when it works. */
export async function heicToDisplayable(blob: Blob): Promise<Blob> {
  const native = await createImageBitmap(blob).catch(() => null);
  if (native) {
    native.close();
    return blob;
  }
  const { heicTo } = await import("heic-to");
  return heicTo({ blob, type: "image/jpeg", quality: 0.92 });
}

async function heicInfo(file: File): Promise<MediaInfo> {
  const bmp = await createImageBitmap(file).catch(async () => {
    const { heicTo } = await import("heic-to");
    return heicTo({ blob: file, type: "bitmap" });
  });
  try {
    return { width: bmp.width, height: bmp.height, thumbnail: (await canvasToBlob(bmp, bmp.width, bmp.height)) ?? undefined };
  } finally {
    bmp.close();
  }
}

function videoInfo(file: File): Promise<MediaInfo> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const done = (info: MediaInfo) => {
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      resolve(info);
    };
    const timer = setTimeout(() => done({}), 15_000);
    video.muted = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, (video.duration || 0) / 10);
    };
    video.onseeked = async () => {
      clearTimeout(timer);
      const info: MediaInfo = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
      info.thumbnail = (await canvasToBlob(video, video.videoWidth, video.videoHeight)) ?? undefined;
      done(info);
    };
    video.onerror = () => {
      clearTimeout(timer);
      done({});
    };
    video.src = url;
  });
}

async function pdfInfo(file: File): Promise<MediaInfo> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: THUMB_MAX / Math.max(base.width, base.height) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    return { thumbnail: (await canvasToBlob(canvas, canvas.width, canvas.height)) ?? undefined };
  } finally {
    await task.destroy();
  }
}

// Thumbnails decode the full image (a 48 MP photo is ~190 MB of pixels), so only a couple run at once
// however many files are uploading.
const MAX_DECODES = 2;
const DECODE_TIMEOUT = 20_000;
let decoding = 0;
const waiting: (() => void)[] = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  // A finishing decode hands its slot straight to the next waiter, so the count never overshoots.
  if (decoding >= MAX_DECODES) await new Promise<void>((r) => waiting.push(r));
  else decoding++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else decoding--;
  }
}

function infoFor(file: File): (() => Promise<MediaInfo>) | null {
  if (isHeic(file)) return () => heicInfo(file);
  if (file.type.startsWith("image/") && file.type !== "image/svg+xml") return () => imageInfo(file);
  if (file.type.startsWith("video/")) return () => videoInfo(file);
  if (file.type === "application/pdf" && file.size < 100 * 1024 * 1024) return () => pdfInfo(file);
  return null;
}

const tabVisible = () =>
  new Promise<void>((resolve) =>
    document.addEventListener("visibilitychange", function on() {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", on);
      resolve();
    }),
  );

/** Best-effort dimensions/duration and a small webp thumbnail. Never throws, and gives up after 20s. */
export async function mediaInfo(file: File): Promise<MediaInfo> {
  const run = infoFor(file);
  if (!run) return {};
  // Chrome doesn't load video in a hidden tab, so a video thumbnail waits until the tab is visible again.
  if (file.type.startsWith("video/") && document.hidden) await tabVisible();
  try {
    return await limited(() => Promise.race([run(), new Promise<MediaInfo>((r) => setTimeout(() => r({}), DECODE_TIMEOUT))]));
  } catch (err) {
    console.warn("thumbnail failed", file.name, err);
    return {};
  }
}
