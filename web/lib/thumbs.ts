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

/** Best-effort dimensions/duration and a small webp thumbnail. Never throws. */
export async function mediaInfo(file: File): Promise<MediaInfo> {
  try {
    if (file.type.startsWith("image/") && file.type !== "image/svg+xml") return await imageInfo(file);
    if (file.type.startsWith("video/")) return await videoInfo(file);
    if (file.type === "application/pdf" && file.size < 100 * 1024 * 1024) return await pdfInfo(file);
  } catch (err) {
    console.warn("thumbnail failed", file.name, err);
  }
  return {};
}
