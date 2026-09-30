import { Hono } from "hono";
import { getSignedCookie, setSignedCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import { newId, randomToken, sha256 } from "../lib/crypto";
import { createSession, destroySession, issueSessionToken, loadUser, requireUser } from "../lib/session";
import { exchangeCode, fetchProfile, googleAuthUrl, saveDriveToken, verifyIdToken, DRIVE_SCOPE, type GoogleProfile } from "../lib/google";
import { notify } from "../lib/notify";
import { quotaFor } from "./files";

type OAuthState = { state: string; returnTo: string; drive: boolean };

const STATE_COOKIE = "oauth_state";

/** Only allow same-site relative redirects. */
export function safeReturn(value: string | undefined | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

/**
 * Find or create the user for a verified Google profile. New accounts need a pending invite (or the owner's email).
 * Returns null when the person isn't invited.
 */
async function signInProfile(env: Env, profile: GoogleProfile): Promise<string | null> {
  const email = profile.email.toLowerCase();
  const now = Date.now();
  let user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (!user) {
    const isOwner = email === env.OWNER_EMAIL.toLowerCase();
    const invite = isOwner
      ? null
      : await env.DB.prepare(
          `SELECT id, invited_by FROM invites
            WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
            ORDER BY created_at DESC LIMIT 1`,
        )
          .bind(email, now)
          .first<{ id: string; invited_by: string }>();
    if (!isOwner && !invite) return null;

    user = { id: newId() };
    await env.DB.prepare(
      "INSERT INTO users (id, email, name, avatar_url, role, storage_used, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    )
      .bind(user.id, email, profile.name ?? email.split("@")[0], profile.picture ?? null, isOwner ? "owner" : "member", now)
      .run();
    if (invite) {
      await env.DB.prepare("UPDATE invites SET accepted_at = ? WHERE email = ? AND accepted_at IS NULL").bind(now, email).run();
      await notify(env, { userId: invite.invited_by, type: "invite_accepted", actorId: user.id });
    }
  } else {
    await env.DB.prepare("UPDATE users SET name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?")
      .bind(profile.name ?? null, profile.picture ?? null, user.id)
      .run();
  }
  return user.id;
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

  const userId = await signInProfile(c.env, profile);
  if (!userId) return c.redirect(`/login?error=not_invited&email=${encodeURIComponent(email)}`);
  await createSession(c, userId);
  return c.redirect(saved.returnTo);
});

/** Mobile app sessions last longer so camera backup keeps running without frequent sign-ins. */
const MOBILE_SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** Mobile sign-in: the app signs in with Google natively and sends the ID token; we answer with a Bearer token. */
auth.post("/google/native", async (c) => {
  const { idToken } = await c.req.json<{ idToken?: string }>().catch(() => ({}) as { idToken?: string });
  if (!idToken) return c.json({ error: "Missing idToken" }, 400);
  const profile = await verifyIdToken(c.env, idToken);
  if (!profile) return c.json({ error: "Google sign-in could not be verified" }, 401);
  if (!profile.email_verified) return c.json({ error: "Your Google email isn't verified", code: "unverified" }, 403);
  const userId = await signInProfile(c.env, profile);
  if (!userId) return c.json({ error: `${profile.email} hasn't been invited to this drive`, code: "not_invited" }, 403);
  return c.json({ token: await issueSessionToken(c.env, userId, MOBILE_SESSION_TTL_MS) });
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
