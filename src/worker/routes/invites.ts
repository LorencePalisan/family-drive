import { Hono } from "hono";
import type { AppEnv } from "../types";
import { fail } from "../types";
import { newId, randomToken, sha256 } from "../lib/crypto";
import { requireOwner } from "../lib/session";
import { sendInviteEmail } from "../lib/email";

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Issue a fresh token for an invite row and email it. Tokens are only stored hashed. */
async function issue(env: Env, inviteId: string, email: string, inviter: { name: string; email: string }) {
  const token = randomToken();
  await env.DB.prepare("UPDATE invites SET token_hash = ?, expires_at = ? WHERE id = ?")
    .bind(await sha256(token), Date.now() + INVITE_TTL_MS, inviteId)
    .run();
  return sendInviteEmail(env, { to: email, inviterName: inviter.name, inviterEmail: inviter.email, url: `${env.APP_URL}/invite/${token}` });
}

const invites = new Hono<AppEnv>().use(requireOwner);

invites.get("/", async (c) => {
  const [inv, members] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT id, email, expires_at AS expiresAt, accepted_at AS acceptedAt, created_at AS createdAt FROM invites
        WHERE revoked_at IS NULL AND accepted_at IS NULL ORDER BY created_at DESC`,
    ),
    c.env.DB.prepare(
      `SELECT id, email, name, avatar_url AS avatarUrl, role, storage_used AS storageUsed, created_at AS createdAt
         FROM users ORDER BY created_at`,
    ),
  ]);
  return c.json({ invites: inv.results, members: members.results });
});

invites.post("/", async (c) => {
  const me = c.get("user");
  const { email: raw } = await c.req.json<{ email: string }>();
  const email = (raw ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) fail(400, "Enter a valid email address");
  if (await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) fail(409, "They're already in the family drive");

  const existing = await c.env.DB.prepare("SELECT id FROM invites WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL")
    .bind(email)
    .first<{ id: string }>();
  const id = existing?.id ?? newId();
  if (!existing) {
    await c.env.DB.prepare(
      "INSERT INTO invites (id, email, invited_by, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, email, me.id, `pending-${id}`, 0, Date.now())
      .run();
  }
  const emailed = await issue(c.env, id, email, me);
  return c.json({ id, email, emailed }, existing ? 200 : 201);
});

invites.post("/:id/resend", async (c) => {
  const row = await c.env.DB.prepare("SELECT id, email FROM invites WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL")
    .bind(c.req.param("id"))
    .first<{ id: string; email: string }>();
  if (!row) fail(404, "Invite not found");
  return c.json({ emailed: await issue(c.env, row!.id, row!.email, c.get("user")) });
});

invites.delete("/:id", async (c) => {
  await c.env.DB.prepare("UPDATE invites SET revoked_at = ? WHERE id = ?").bind(Date.now(), c.req.param("id")).run();
  return c.json({ ok: true });
});

export default invites;
