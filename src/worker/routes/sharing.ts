import { Hono } from "hono";
import type { AppEnv } from "../types";
import { fail } from "../types";
import { randomToken } from "../lib/crypto";
import { requireAccess, type FileRecord } from "../lib/access";
import { notify } from "../lib/notify";
import { sendShareEmail } from "../lib/email";

export const itemUrl = (env: Env, f: Pick<FileRecord, "id" | "is_folder">) =>
  `${env.APP_URL}/${f.is_folder ? "folders" : "file"}/${f.id}`;

const sharing = new Hono<AppEnv>();

sharing.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, email, name, avatar_url AS avatarUrl, role FROM users ORDER BY name COLLATE NOCASE",
  ).all();
  return c.json({ users: results });
});

sharing.get("/files/:id/access", async (c) => {
  const me = c.get("user").id;
  const { file, role } = await requireAccess(c.env, c.req.param("id"), me, "viewer");
  const [owner, members, links] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT id, email, name, avatar_url AS avatarUrl FROM users WHERE id = ?").bind(file.owner_id),
    c.env.DB.prepare(
      `WITH RECURSIVE anc(id, parent_id, name, depth) AS (
         SELECT id, parent_id, name, 0 FROM files WHERE id = ?1
         UNION ALL SELECT f.id, f.parent_id, f.name, anc.depth + 1 FROM files f JOIN anc ON f.id = anc.parent_id
       )
       SELECT u.id, u.email, u.name, u.avatar_url AS avatarUrl, s.role, anc.depth,
              CASE WHEN anc.depth > 0 THEN anc.name END AS inheritedFrom
         FROM shares s JOIN anc ON anc.id = s.file_id JOIN users u ON u.id = s.user_id
        ORDER BY anc.depth, u.name COLLATE NOCASE`,
    ).bind(file.id),
    c.env.DB.prepare(
      `SELECT token, expires_at AS expiresAt, created_at AS createdAt FROM share_links
        WHERE file_id = ? AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    ).bind(file.id, Date.now()),
  ]);
  // A person can appear via several ancestors; keep the closest (direct) grant.
  const seen = new Set<string>();
  const people = (members.results as { id: string; depth: number }[]).filter((m) => !seen.has(m.id) && seen.add(m.id));
  return c.json({
    owner: owner.results[0],
    members: people,
    links: (links.results as { token: string }[]).map((l) => ({ ...l, url: `${c.env.APP_URL}/s/${l.token}` })),
    canShare: role !== "viewer",
  });
});

sharing.post("/files/:id/shares", async (c) => {
  const me = c.get("user");
  const { file } = await requireAccess(c.env, c.req.param("id"), me.id, "editor");
  const body = await c.req.json<{ emails: string[]; role: "viewer" | "editor"; message?: string; notify?: boolean }>();
  const role = body.role === "editor" ? "editor" : "viewer";
  const emails = [...new Set((body.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) fail(400, "Add at least one person");

  const { results: users } = await c.env.DB.prepare(
    `SELECT id, email, name FROM users WHERE email IN (${emails.map(() => "?").join(",")})`,
  )
    .bind(...emails)
    .all<{ id: string; email: string; name: string }>();
  const missing = emails.filter((e) => !users.some((u) => u.email === e));
  if (missing.length) fail(422, `Not in the family yet: ${missing.join(", ")}. Invite them first.`);

  const now = Date.now();
  const targets = users.filter((u) => u.id !== file.owner_id);
  if (targets.length) {
    await c.env.DB.batch(
      targets.map((u) =>
        c.env.DB.prepare(
          `INSERT INTO shares (file_id, user_id, role, shared_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (file_id, user_id) DO UPDATE SET role = ?3`,
        ).bind(file.id, u.id, role, me.id, now),
      ),
    );
  }
  const message = body.message?.slice(0, 1000);
  for (const u of targets) {
    await notify(c.env, { userId: u.id, type: "shared", actorId: me.id, fileId: file.id, payload: { role, message } });
    if (body.notify !== false) {
      c.executionCtx.waitUntil(
        sendShareEmail(c.env, {
          to: u.email,
          actorName: me.name,
          actorEmail: me.email,
          fileName: file.name,
          isFolder: !!file.is_folder,
          role,
          url: itemUrl(c.env, file),
          message,
        }),
      );
    }
  }
  return c.json({ shared: targets.length });
});

sharing.patch("/files/:id/shares/:userId", async (c) => {
  const { file } = await requireAccess(c.env, c.req.param("id"), c.get("user").id, "editor");
  const { role } = await c.req.json<{ role: "viewer" | "editor" }>();
  await c.env.DB.prepare("UPDATE shares SET role = ? WHERE file_id = ? AND user_id = ?")
    .bind(role === "editor" ? "editor" : "viewer", file.id, c.req.param("userId"))
    .run();
  return c.json({ ok: true });
});

sharing.delete("/files/:id/shares/:userId", async (c) => {
  const me = c.get("user").id;
  const target = c.req.param("userId");
  // Editors can remove anyone; anyone can remove themselves ("Remove from Shared with me").
  const { file } = await requireAccess(c.env, c.req.param("id"), me, target === me ? "viewer" : "editor");
  await c.env.DB.prepare("DELETE FROM shares WHERE file_id = ? AND user_id = ?").bind(file.id, target).run();
  return c.json({ ok: true });
});

sharing.post("/files/:id/links", async (c) => {
  const me = c.get("user").id;
  const { file } = await requireAccess(c.env, c.req.param("id"), me, "editor");
  const body = await c.req.json<{ expiresInDays?: number | null }>().catch(() => ({}) as { expiresInDays?: number | null });
  const now = Date.now();
  const existing = await c.env.DB.prepare(
    "SELECT token FROM share_links WHERE file_id = ? AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
  )
    .bind(file.id, now)
    .first<{ token: string }>();
  const days = Number(body.expiresInDays);
  const expiresAt = days > 0 ? now + days * 86_400_000 : null;
  let token = existing?.token;
  if (token) {
    if (body.expiresInDays !== undefined) {
      await c.env.DB.prepare("UPDATE share_links SET expires_at = ? WHERE token = ?").bind(expiresAt, token).run();
    }
  } else {
    token = randomToken(18);
    await c.env.DB.prepare("INSERT INTO share_links (token, file_id, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(token, file.id, expiresAt, me, now)
      .run();
  }
  return c.json({ token, url: `${c.env.APP_URL}/s/${token}`, expiresAt });
});

sharing.delete("/files/:id/links", async (c) => {
  const { file } = await requireAccess(c.env, c.req.param("id"), c.get("user").id, "editor");
  await c.env.DB.prepare("UPDATE share_links SET disabled_at = ? WHERE file_id = ? AND disabled_at IS NULL")
    .bind(Date.now(), file.id)
    .run();
  return c.json({ ok: true });
});

export default sharing;
