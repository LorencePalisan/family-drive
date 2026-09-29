import { Hono } from "hono";
import type { AppEnv } from "./types";
import { HttpError } from "./types";
import { requireUser } from "./lib/session";
import { purgeFiles } from "./lib/storage";
import auth, { inviteLanding, me } from "./routes/auth";
import files from "./routes/files";
import uploads from "./routes/uploads";
import { content, publicLinks } from "./routes/content";
import sharing from "./routes/sharing";
import invites from "./routes/invites";
import notifications from "./routes/notifications";
import google from "./routes/google";
import gsync from "./routes/gsync";
import { gsyncHousekeeping, runSync } from "./lib/gsync";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error(err);
  const message = err instanceof HttpError ? err.message : "Something went wrong";
  // Browser navigations (e.g. "Open with Google" in a new tab) get a readable page instead of JSON.
  if (c.req.method === "GET" && c.req.header("accept")?.includes("text/html")) {
    return c.html(
      `<!doctype html><meta name="viewport" content="width=device-width"><title>${status}</title>
       <body style="font-family:system-ui;padding:48px 16px;max-width:560px;margin:auto;color:#1f1f1f">
       <h2 style="font-weight:400">${message.replace(/</g, "&lt;")}</h2><p><a href="/">Back to Family Drive</a></p></body>`,
      status,
    );
  }
  return c.json({ error: message }, status);
});

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", auth);
app.route("/api/me", me);
app.route("/invite", inviteLanding);
app.route("/api/public", publicLinks);
app.route("/api/files", content);

const api = new Hono<AppEnv>().use(requireUser);
api.route("/", files);
api.route("/", uploads);
api.route("/", sharing);
api.route("/", google);
api.route("/", gsync);
api.route("/notifications", notifications);
api.route("/invites", invites);
app.route("/api", api);

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

const DAY = 86_400_000;
const HOUSEKEEPING_CRON = "0 3 * * *";

export default {
  fetch: app.fetch,

  async scheduled(event, env) {
    // Every minute: copy the next batch of Google Drive sync work. Leases in runSync keep overlapping runs apart.
    if (event.cron !== HOUSEKEEPING_CRON) return runSync(env, { ms: 50_000 });
    await housekeeping(env);
  },
} satisfies ExportedHandler<Env>;

/** Daily housekeeping: empty old trash, abort abandoned uploads, drop expired sessions. */
async function housekeeping(env: Env) {
  const now = Date.now();
  const { results: old } = await env.DB.prepare("SELECT id FROM files WHERE trashed_at IS NOT NULL AND trashed_at < ?")
    .bind(now - 30 * DAY)
    .all<{ id: string }>();
  if (old.length) await purgeFiles(env, old.map((r) => r.id));

  const { results: stale } = await env.DB.prepare("SELECT id, r2_key, r2_upload_id FROM uploads WHERE status = 'pending' AND created_at < ?")
    .bind(now - 2 * DAY)
    .all<{ id: string; r2_key: string; r2_upload_id: string }>();
  for (const u of stale) {
    await env.BUCKET.resumeMultipartUpload(u.r2_key, u.r2_upload_id).abort().catch(() => {});
    await env.DB.prepare("UPDATE uploads SET status = 'aborted' WHERE id = ?").bind(u.id).run();
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM uploads WHERE status <> 'pending' AND created_at < ?").bind(now - 7 * DAY),
    env.DB.prepare("DELETE FROM notifications WHERE created_at < ?").bind(now - 90 * DAY),
    // Views only read the newest few hundred recents per person; bulk uploads would otherwise grow this forever.
    env.DB.prepare(
      `DELETE FROM recents WHERE (user_id, file_id) IN (
         SELECT user_id, file_id FROM (SELECT user_id, file_id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY at DESC) AS rn FROM recents)
          WHERE rn > 500)`,
    ),
  ]);
  await gsyncHousekeeping(env);
  console.log(`cleanup: purged ${old.length} trashed items, aborted ${stale.length} uploads`);
}
