import { Hono } from "hono";
import type { AppEnv } from "../types";
import { fail } from "../types";
import { newId } from "../lib/crypto";
import { atLeast, fileDTO, requireAccess, type FileRecord } from "../lib/access";
import { driveAccessToken } from "../lib/google";
import { fileKey } from "../lib/storage";
import { notify } from "../lib/notify";
import { assertQuota, touchRecent } from "./files";

type App = "docs" | "sheets" | "slides";

const APPS: Record<App, { googleMime: string; exportMime: string; ext: string; accepts: RegExp }> = {
  docs: {
    googleMime: "application/vnd.google-apps.document",
    exportMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: "docx",
    // PDFs are converted (with OCR for scanned pages) into an editable Doc; the PDF itself is never overwritten.
    accepts: /\.(docx?|odt|rtf|txt|html?|pdf)$/i,
  },
  sheets: {
    googleMime: "application/vnd.google-apps.spreadsheet",
    exportMime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: "xlsx",
    accepts: /\.(xlsx?|xlsm|ods|csv|tsv)$/i,
  },
  slides: {
    googleMime: "application/vnd.google-apps.presentation",
    exportMime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ext: "pptx",
    accepts: /\.(pptx?|odp)$/i,
  },
};

/** Which Google editor (if any) can open this file. Shared with the frontend's "Open with" menu logic. */
export function googleAppFor(name: string): App | null {
  for (const [app, cfg] of Object.entries(APPS) as [App, (typeof APPS)[App]][]) if (cfg.accepts.test(name)) return app;
  return null;
}

const stripExt = (name: string) => name.replace(/\.[^.]+$/, "");
const isPdf = (file: FileRecord) => file.mime === "application/pdf" || /\.pdf$/i.test(file.name);

async function gfetch(token: string, url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`);
  return res;
}

async function importToGoogle(env: Env, token: string, file: FileRecord, app: App) {
  const version = await env.DB.prepare("SELECT r2_key FROM file_versions WHERE id = ?").bind(file.current_version_id).first<{ r2_key: string }>();
  const obj = version && (await env.BUCKET.get(version.r2_key));
  if (!obj) fail(404, "File content missing");

  const mime = file.mime || "application/octet-stream";
  const session = await gfetch(token, "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": mime,
      "x-upload-content-length": String(obj!.size),
    },
    // Tagged so Google Drive sync never copies our own "Open with" copies back into Family Drive.
    body: JSON.stringify({ name: stripExt(file.name), mimeType: APPS[app].googleMime, appProperties: { familyDrive: "1" } }),
  });
  const location = session.headers.get("location");
  if (!location) throw new Error("Google did not return an upload session");
  const res = await gfetch(token, location, {
    method: "PUT",
    headers: { "content-type": mime, "content-length": String(obj!.size) },
    body: obj!.body,
  });
  return (await res.json()) as { id: string; webViewLink: string };
}

const google = new Hono<AppEnv>();

/**
 * Opened in a new browser tab by "Open with → Google Docs/Sheets/Slides".
 * Connects Google Drive first if needed, then imports (or reuses) a converted copy and redirects into the editor.
 */
google.get("/files/:id/open-in-google", async (c) => {
  const me = c.get("user").id;
  const { file } = await requireAccess(c.env, c.req.param("id"), me, "viewer");
  const app = (c.req.query("app") as App) || googleAppFor(file.name);
  if (!app || !APPS[app]) fail(400, "This file type can't be opened in Google");
  if (!APPS[app].accepts.test(file.name)) fail(400, `This file can't be opened in Google ${app[0].toUpperCase()}${app.slice(1)}`);

  const token = await driveAccessToken(c.env, me);
  if (!token) {
    const back = `/api/files/${file.id}/open-in-google?app=${app}`;
    return c.redirect(`/api/auth/google?drive=1&return=${encodeURIComponent(back)}`);
  }

  // Reuse the existing Google copy if our file hasn't changed since it was imported and it still exists.
  const link = await c.env.DB.prepare("SELECT google_file_id, web_view_link, source_version_id FROM google_links WHERE file_id = ? AND user_id = ?")
    .bind(file.id, me)
    .first<{ google_file_id: string; web_view_link: string; source_version_id: string }>();
  if (link && link.source_version_id === file.current_version_id) {
    const meta = await gfetch(token, `https://www.googleapis.com/drive/v3/files/${link.google_file_id}?fields=trashed`)
      .then((r) => r.json<{ trashed: boolean }>())
      .catch(() => null);
    if (meta && !meta.trashed) {
      if (isPdf(file)) await ensurePdfDocx(c.env, token, file, me, link.google_file_id, link.web_view_link, null);
      return c.redirect(link.web_view_link);
    }
  }

  const created = await importToGoogle(c.env, token, file, app);
  await c.env.DB.prepare(
    `INSERT INTO google_links (file_id, user_id, google_file_id, google_mime, web_view_link, source_version_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (file_id, user_id) DO UPDATE SET google_file_id = ?3, google_mime = ?4, web_view_link = ?5, source_version_id = ?6, created_at = ?7`,
  )
    .bind(file.id, me, created.id, APPS[app].googleMime, created.webViewLink, file.current_version_id, Date.now())
    .run();
  if (isPdf(file)) await ensurePdfDocx(c.env, token, file, me, created.id, created.webViewLink, link?.google_file_id ?? null);
  await touchRecent(c.env, me, file.id, "opened");
  return c.redirect(created.webViewLink);
});

google.get("/files/:id/google-link", async (c) => {
  const me = c.get("user").id;
  await requireAccess(c.env, c.req.param("id"), me, "viewer");
  const link = await c.env.DB.prepare("SELECT web_view_link AS webViewLink, created_at AS createdAt FROM google_links WHERE file_id = ? AND user_id = ?")
    .bind(c.req.param("id"), me)
    .first();
  return c.json({ link });
});

/** Pull the edited Google copy back as a new version of our file (exported to docx/xlsx/pptx). */
google.post("/files/:id/save-from-google", async (c) => {
  const me = c.get("user");
  const { file } = await requireAccess(c.env, c.req.param("id"), me.id, "viewer");
  const pdf = isPdf(file);
  // A PDF is only read (its Doc is saved to a separate .docx), so viewers may do it; anything else is overwritten.
  if (!pdf) await requireAccess(c.env, file.id, me.id, "editor");
  const link = await c.env.DB.prepare("SELECT google_file_id, google_mime FROM google_links WHERE file_id = ? AND user_id = ?")
    .bind(file.id, me.id)
    .first<{ google_file_id: string; google_mime: string }>();
  if (!link) fail(404, "Open this file in Google first");
  const app = (Object.keys(APPS) as App[]).find((a) => APPS[a].googleMime === link!.google_mime)!;
  const token = await driveAccessToken(c.env, me.id);
  if (!token) fail(401, "Reconnect Google Drive and try again");

  const bytes = await exportFromGoogle(token!, link!.google_file_id, app);
  await assertQuota(c.env, me.id, bytes.byteLength);
  const name = `${stripExt(file.name)}.${APPS[app].ext}`;

  if (pdf) {
    // Update the .docx an earlier save made from this Doc, if it's still around and editable; otherwise make a new one.
    const target = await pdfDocxFor(c.env, me.id, link!.google_file_id, file.id);
    const savedId = target
      ? await saveVersion(c.env, target.file, bytes, APPS[app].exportMime, target.file.name, me.id)
      : await createFromGoogle(c.env, file, bytes, APPS[app].exportMime, name, me.id, link!);
    return c.json({ ...(await fileDTO(c.env, savedId, me.id)), created: !target }, target ? 200 : 201);
  }

  await saveVersion(c.env, file, bytes, APPS[app].exportMime, name, me.id);
  return c.json(await fileDTO(c.env, file.id, me.id));
});

/** Download a Google file as docx/xlsx/pptx. exportLinks avoids the 10 MB limit of files.export. */
async function exportFromGoogle(token: string, googleFileId: string, app: App) {
  const meta = await (await gfetch(token, `https://www.googleapis.com/drive/v3/files/${googleFileId}?fields=exportLinks`)).json<{
    exportLinks?: Record<string, string>;
  }>();
  const exportUrl = meta.exportLinks?.[APPS[app].exportMime];
  if (!exportUrl) fail(502, "Google can't export this file");
  return (await gfetch(token, exportUrl!)).arrayBuffer();
}

/** The .docx saved from a PDF's Google Doc, if it still exists and the user can still update it. */
async function pdfDocxFor(env: Env, userId: string, googleFileId: string, pdfId: string) {
  const row = await env.DB.prepare(
    `SELECT gl.file_id FROM google_links gl JOIN files f ON f.id = gl.file_id
     WHERE gl.user_id = ? AND gl.google_file_id = ? AND gl.file_id != ? AND f.trashed_at IS NULL`,
  )
    .bind(userId, googleFileId, pdfId)
    .first<{ file_id: string }>();
  return row ? await requireAccess(env, row.file_id, userId, "editor").catch(() => null) : null;
}

/**
 * Opening a PDF in Google Docs also saves the converted Doc to Family Drive as a .docx right away.
 * If the PDF was converted before (an older Google Doc), that earlier .docx is updated and relinked instead of duplicated.
 * Best effort: a failure here still lets the user into Google Docs, and "Save as Word document" can retry.
 */
async function ensurePdfDocx(
  env: Env,
  token: string,
  pdf: FileRecord,
  userId: string,
  googleFileId: string,
  webViewLink: string,
  previousGoogleFileId: string | null,
) {
  try {
    if (await pdfDocxFor(env, userId, googleFileId, pdf.id)) return;
    const bytes = await exportFromGoogle(token, googleFileId, "docs");
    await assertQuota(env, userId, bytes.byteLength);
    const mime = APPS.docs.exportMime;
    const earlier = previousGoogleFileId && previousGoogleFileId !== googleFileId ? await pdfDocxFor(env, userId, previousGoogleFileId, pdf.id) : null;
    if (earlier) {
      await env.DB.prepare("UPDATE google_links SET google_file_id = ?, web_view_link = ? WHERE file_id = ? AND user_id = ?")
        .bind(googleFileId, webViewLink, earlier.file.id, userId)
        .run();
      await saveVersion(env, earlier.file, bytes, mime, earlier.file.name, userId);
    } else {
      await createFromGoogle(env, pdf, bytes, mime, `${stripExt(pdf.name)}.docx`, userId, { google_file_id: googleFileId, google_mime: APPS.docs.googleMime });
    }
  } catch (err) {
    console.error("saving .docx from PDF failed", pdf.id, err);
  }
}

/** Store exported bytes as the file's new current version. The Google copy then matches it, so reopening reuses it. */
async function saveVersion(env: Env, file: FileRecord, bytes: ArrayBuffer, mime: string, name: string, userId: string) {
  const versionId = newId();
  const key = fileKey(file.id, versionId);
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO file_versions (id, file_id, r2_key, size, mime, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'google_saveback', ?, ?)",
    ).bind(versionId, file.id, key, bytes.byteLength, mime, userId, now),
    env.DB.prepare("UPDATE files SET current_version_id = ?, size = ?, mime = ?, name = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(
      versionId,
      bytes.byteLength,
      mime,
      name,
      now,
      userId,
      file.id,
    ),
    env.DB.prepare("UPDATE users SET storage_used = storage_used + ? WHERE id = ?").bind(bytes.byteLength, userId),
    env.DB.prepare("UPDATE google_links SET source_version_id = ? WHERE file_id = ? AND user_id = ?").bind(versionId, file.id, userId),
  ]);
  await touchRecent(env, userId, file.id, "modified");
  if (file.owner_id !== userId) await notify(env, { userId: file.owner_id, type: "google_saved", actorId: userId, fileId: file.id });
  return file.id;
}

/**
 * Save a Doc converted from a PDF as a new file next to the PDF (or in My Files if the saver can't write there),
 * linked to the same Google Doc so later saves and "Open with" on the new file use it.
 */
async function createFromGoogle(
  env: Env,
  source: FileRecord,
  bytes: ArrayBuffer,
  mime: string,
  name: string,
  userId: string,
  link: { google_file_id: string; google_mime: string },
) {
  let parentId: string | null = null;
  if (source.parent_id) {
    const parent = await requireAccess(env, source.parent_id, userId, "viewer").catch(() => null);
    if (parent && atLeast(parent.role, "editor")) parentId = source.parent_id;
  }
  const id = newId();
  const versionId = newId();
  const key = fileKey(id, versionId);
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
  const webViewLink = await env.DB.prepare("SELECT web_view_link FROM google_links WHERE file_id = ? AND user_id = ?")
    .bind(source.id, userId)
    .first<string>("web_view_link");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO files (id, owner_id, parent_id, name, is_folder, mime, size, current_version_id, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, userId, parentId, name, mime, bytes.byteLength, versionId, now, now, userId),
    env.DB.prepare(
      "INSERT INTO file_versions (id, file_id, r2_key, size, mime, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'google_saveback', ?, ?)",
    ).bind(versionId, id, key, bytes.byteLength, mime, userId, now),
    env.DB.prepare("UPDATE users SET storage_used = storage_used + ? WHERE id = ?").bind(bytes.byteLength, userId),
    env.DB.prepare(
      `INSERT INTO google_links (file_id, user_id, google_file_id, google_mime, web_view_link, source_version_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, userId, link.google_file_id, link.google_mime, webViewLink ?? "", versionId, now),
  ]);
  await touchRecent(env, userId, id, "modified");
  return id;
}

google.delete("/google", async (c) => {
  const me = c.get("user").id;
  const token = await driveAccessToken(c.env, me);
  if (token) await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: "POST" }).catch(() => {});
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM google_tokens WHERE user_id = ?").bind(me),
    // Sync can't run without access; Resume after reconnecting picks up where it left off.
    c.env.DB.prepare("UPDATE gsync_sources SET status = 'error', status_message = ? WHERE user_id = ? AND status <> 'paused'").bind(
      "Google Drive was disconnected. Reconnect, then press Resume.",
      me,
    ),
  ]);
  return c.json({ ok: true });
});

export default google;
