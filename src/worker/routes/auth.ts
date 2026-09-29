import { Hono } from "hono";
import { getSignedCookie, setSignedCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import { newId, randomToken, sha256 } from "../lib/crypto";
import { createSession, destroySession, loadUser, requireUser } from "../lib/session";
import { exchangeCode, fetchProfile, googleAuthUrl, saveDriveToken, DRIVE_SCOPE } from "../lib/google";
import { notify } from "../lib/notify";
import { quotaFor } from "./files";

type OAuthState = { state: string; returnTo: string; drive: boolean };

const STATE_COOKIE = "oauth_state";

/** Only allow same-site relative redirects. */
export function safeReturn(value: string | undefined | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

const auth = new Hono<AppEnv>();

auth.get("/google", async (c) => {
  const drive = c.req.query("drive") === "1";
  const returnTo = safeReturn(c.req.query("return"));
  const state = randomToken(16);
  const current = await loadUser(c);
  await setSignedCookie(c, STATE_COOKIE, JSON.stringify({ state, returnTo, drive } satisfies OAuthState), c.env.TOKEN_ENC_KEY, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/api/auth",
    maxAge: 600,
  });
  return c.redirect(googleAuthUrl(c.env, { state, drive, loginHint: current?.email ?? c.req.query("hint") }));
});

auth.get("/google/callback", async (c) => {
  const raw = await getSignedCookie(c, c.env.TOKEN_ENC_KEY, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/api/auth" });
  const saved: OAuthState | null = raw ? JSON.parse(raw) : null;
  if (!saved || saved.state !== c.req.query("state")) return c.redirect("/login?error=state");
  const code = c.req.query("code");
  if (!code) return c.redirect(`/login?error=${encodeURIComponent(c.req.query("error") ?? "cancelled")}`);

  const tokens = await exchangeCode(c.env, code);
  const profile = await fetchProfile(tokens.access_token);
  const email = profile.email.toLowerCase();
  if (!profile.email_verified) return c.redirect("/login?error=unverified");

  // Connecting Google Drive for "Open with": the signed-in user must match the Google account.
  if (saved.drive) {
    const current = await loadUser(c);
    if (!current) return c.redirect("/login");
    if (current.email !== email) return c.redirect(`${saved.returnTo}${saved.returnTo.includes("?") ? "&" : "?"}google_error=account_mismatch`);
    if (!tokens.refresh_token || !tokens.scope.includes(DRIVE_SCOPE)) {
      return c.redirect(`${saved.returnTo}${saved.returnTo.includes("?") ? "&" : "?"}google_error=not_granted`);
    }
    await saveDriveToken(c.env, current.id, tokens.refresh_token, tokens.scope);
    return c.redirect(saved.returnTo);
  }

  const now = Date.now();
  let user = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (!user) {
    const isOwner = email === c.env.OWNER_EMAIL.toLowerCase();
    const invite = isOwner
      ? null
      : await c.env.DB.prepare(
          `SELECT id, invited_by FROM invites
            WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
            ORDER BY created_at DESC LIMIT 1`,
        )
          .bind(email, now)
          .first<{ id: string; invited_by: string }>();
    if (!isOwner && !invite) return c.redirect(`/login?error=not_invited&email=${encodeURIComponent(email)}`);

    user = { id: newId() };
    await c.env.DB.prepare(
      "INSERT INTO users (id, email, name, avatar_url, role, storage_used, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    )
      .bind(user.id, email, profile.name ?? email.split("@")[0], profile.picture ?? null, isOwner ? "owner" : "member", now)
      .run();
    if (invite) {
      await c.env.DB.prepare("UPDATE invites SET accepted_at = ? WHERE email = ? AND accepted_at IS NULL").bind(now, email).run();
      await notify(c.env, { userId: invite.invited_by, type: "invite_accepted", actorId: user.id });
    }
  } else {
    await c.env.DB.prepare("UPDATE users SET name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?")
      .bind(profile.name ?? null, profile.picture ?? null, user.id)
      .run();
  }

  await createSession(c, user.id);
  return c.redirect(saved.returnTo);
});

auth.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

/** Landing link from an invite email: validate it, then send them through Google sign-in. */
export const inviteLanding = new Hono<AppEnv>().get("/:token", async (c) => {
  const invite = await c.env.DB.prepare(
    "SELECT email FROM invites WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
  )
    .bind(await sha256(c.req.param("token")), Date.now())
    .first<{ email: string }>();
  if (!invite) return c.redirect("/login?error=invite_invalid");
  return c.redirect(`/api/auth/google?hint=${encodeURIComponent(invite.email)}`);
});

const THEMES = ["system", "light", "dark"] as const;

export const me = new Hono<AppEnv>().patch("/", requireUser, async (c) => {
  const { theme } = await c.req.json<{ theme?: string }>();
  if (!THEMES.includes(theme as (typeof THEMES)[number])) return c.json({ error: "Theme must be system, light or dark" }, 400);
  await c.env.DB.prepare("UPDATE users SET theme = ? WHERE id = ?").bind(theme, c.get("user").id).run();
  return c.json({ theme });
});

me.get("/", requireUser, async (c) => {
  const user = c.get("user");
  const drive = await c.env.DB.prepare("SELECT 1 FROM google_tokens WHERE user_id = ?").bind(user.id).first();
  return c.json({
    ...user,
    storageQuota: quotaFor(c.env, user.storageQuota),
    googleDriveConnected: !!drive,
    appName: c.env.APP_NAME,
  });
});

export default auth;
