import { Hono } from "hono";
import type { AppEnv } from "../types";
import { fail } from "../types";
import { newId } from "../lib/crypto";
import { fileDTO, requireAccess, type FileRecord } from "../lib/access";
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
    accepts: /\.(docx?|odt|rtf|txt|html?)$/i,
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
    body: JSON.stringify({ name: stripExt(file.name), mimeType: APPS[app].googleMime }),
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
    if (meta && !meta.trashed) return c.redirect(link.web_view_link);
  }

  const created = await importToGoogle(c.env, token, file, app);
  await c.env.DB.prepare(
    `INSERT INTO google_links (file_id, user_id, google_file_id, google_mime, web_view_link, source_version_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (file_id, user_id) DO UPDATE SET google_file_id = ?3, google_mime = ?4, web_view_link = ?5, source_version_id = ?6, created_at = ?7`,
  )
    .bind(file.id, me, created.id, APPS[app].googleMime, created.webViewLink, file.current_version_id, Date.now())
    .run();
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
  const { file } = await requireAccess(c.env, c.req.param("id"), me.id, "editor");
  const link = await c.env.DB.prepare("SELECT google_file_id, google_mime FROM google_links WHERE file_id = ? AND user_id = ?")
    .bind(file.id, me.id)
    .first<{ google_file_id: string; google_mime: string }>();
  if (!link) fail(404, "Open this file in Google first");
  const app = (Object.keys(APPS) as App[]).find((a) => APPS[a].googleMime === link!.google_mime)!;
  const token = await driveAccessToken(c.env, me.id);
  if (!token) fail(401, "Reconnect Google Drive and try again");

  // exportLinks avoids the 10 MB limit of files.export.
  const meta = await (await gfetch(token!, `https://www.googleapis.com/drive/v3/files/${link!.google_file_id}?fields=exportLinks`)).json<{
    exportLinks?: Record<string, string>;
  }>();
  const exportUrl = meta.exportLinks?.[APPS[app].exportMime];
  if (!exportUrl) fail(502, "Google can't export this file");
  const bytes = await (await gfetch(token!, exportUrl!)).arrayBuffer();
  await assertQuota(c.env, me.id, bytes.byteLength);

  const versionId = newId();
  const key = fileKey(file.id, versionId);
  const mime = APPS[app].exportMime;
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
  const now = Date.now();
  const name = `${stripExt(file.name)}.${APPS[app].ext}`;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO file_versions (id, file_id, r2_key, size, mime, source, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'google_saveback', ?, ?)",
    ).bind(versionId, file.id, key, bytes.byteLength, mime, me.id, now),
    c.env.DB.prepare("UPDATE files SET current_version_id = ?, size = ?, mime = ?, name = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(
      versionId,
      bytes.byteLength,
      mime,
      name,
      now,
      me.id,
      file.id,
    ),
    c.env.DB.prepare("UPDATE users SET storage_used = storage_used + ? WHERE id = ?").bind(bytes.byteLength, me.id),
    // The Google copy now matches the new version, so reopening reuses it.
    c.env.DB.prepare("UPDATE google_links SET source_version_id = ? WHERE file_id = ? AND user_id = ?").bind(versionId, file.id, me.id),
  ]);
  await touchRecent(c.env, me.id, file.id, "modified");
  if (file.owner_id !== me.id) {
    await notify(c.env, { userId: file.owner_id, type: "google_saved", actorId: me.id, fileId: file.id });
  }
  return c.json(await fileDTO(c.env, file.id, me.id));
});

google.delete("/google", async (c) => {
  const me = c.get("user").id;
  const token = await driveAccessToken(c.env, me);
  if (token) await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: "POST" }).catch(() => {});
  await c.env.DB.prepare("DELETE FROM google_tokens WHERE user_id = ?").bind(me).run();
  return c.json({ ok: true });
});

export default google;
