export const PART_SIZE = 50 * 1024 * 1024; // browser → Worker → R2 part size (under the 100 MB request limit)
const COPY_PART_SIZE = 100 * 1024 * 1024;

export const fileKey = (fileId: string, versionId: string) => `files/${fileId}/${versionId}`;
export const thumbKey = (fileId: string) => `thumbs/${fileId}.webp`;

// Types that are safe to render inline on our own origin. Everything else is forced to download,
// so an uploaded HTML/SVG file can never run script as the app.
const INLINE_SAFE = /^(image\/(png|jpe?g|gif|webp|avif|bmp|heic|heif|x-icon)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)$/i;

export function contentDisposition(kind: "inline" | "attachment", name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Stream an R2 object with HTTP Range / conditional request support (needed for video seeking). */
export async function serveObject(
  bucket: R2Bucket,
  req: Request,
  opts: { key: string; name: string; mime: string | null; download: boolean; cacheControl?: string },
): Promise<Response> {
  const hasRange = req.headers.has("range");
  const obj = await bucket.get(opts.key, { range: hasRange ? req.headers : undefined, onlyIf: req.headers });
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", opts.cacheControl ?? "private, max-age=3600");
  headers.set("x-content-type-options", "nosniff");
  const mime = opts.mime || "application/octet-stream";
  const inline = !opts.download && INLINE_SAFE.test(mime);
  headers.set("content-type", inline ? mime : opts.download ? mime : "application/octet-stream");
  headers.set("content-disposition", contentDisposition(inline ? "inline" : "attachment", opts.name));

  if (!("body" in obj)) return new Response(null, { status: 304, headers });

  if (hasRange && obj.range) {
    const r = obj.range as { offset?: number; length?: number; suffix?: number };
    const start = r.suffix !== undefined ? obj.size - r.suffix : (r.offset ?? 0);
    const length = r.suffix !== undefined ? r.suffix : (r.length ?? obj.size - start);
    headers.set("content-range", `bytes ${start}-${start + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

/** Server-side copy. The R2 binding has no copy call, so stream it (in parts for large objects). */
export async function copyObject(bucket: R2Bucket, src: string, dst: string, size: number, mime: string | null) {
  const httpMetadata = mime ? { contentType: mime } : undefined;
  if (size <= COPY_PART_SIZE) {
    const obj = await bucket.get(src);
    if (!obj) throw new Error(`copy source missing: ${src}`);
    await bucket.put(dst, obj.body, { httpMetadata });
    return;
  }
  const upload = await bucket.createMultipartUpload(dst, { httpMetadata });
  try {
    const parts: R2UploadedPart[] = [];
    for (let offset = 0, n = 1; offset < size; offset += COPY_PART_SIZE, n++) {
      const obj = await bucket.get(src, { range: { offset, length: Math.min(COPY_PART_SIZE, size - offset) } });
      if (!obj) throw new Error(`copy source missing: ${src}`);
      parts.push(await upload.uploadPart(n, obj.body));
    }
    await upload.complete(parts);
  } catch (err) {
    await upload.abort();
    throw err;
  }
}

const chunk = <T>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/** Permanently delete files (and all their versions/thumbnails) and give the storage back to whoever uploaded it. */
export async function purgeFiles(env: Env, ids: string[]) {
  for (const batch of chunk(ids, 90)) {
    const marks = batch.map(() => "?").join(",");
    const [versions, thumbs] = await env.DB.batch([
      env.DB.prepare(`SELECT r2_key, size, created_by FROM file_versions WHERE file_id IN (${marks})`).bind(...batch),
      env.DB.prepare(`SELECT thumb_key FROM files WHERE id IN (${marks}) AND thumb_key IS NOT NULL`).bind(...batch),
    ]);
    const vs = versions.results as { r2_key: string; size: number; created_by: string }[];
    const keys = [...vs.map((v) => v.r2_key), ...(thumbs.results as { thumb_key: string }[]).map((t) => t.thumb_key)];
    for (const k of chunk(keys, 1000)) if (k.length) await env.BUCKET.delete(k);

    const freed = new Map<string, number>();
    for (const v of vs) freed.set(v.created_by, (freed.get(v.created_by) ?? 0) + v.size);
    await env.DB.batch([
      ...[...freed].map(([userId, bytes]) =>
        env.DB.prepare("UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE id = ?").bind(bytes, userId),
      ),
      env.DB.prepare(`DELETE FROM files WHERE id IN (${marks})`).bind(...batch),
    ]);
  }
}
