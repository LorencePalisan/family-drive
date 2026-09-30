import { decrypt, encrypt } from "./crypto";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const BASE_SCOPES = ["openid", "email", "profile"];

export const redirectUri = (env: Env) => `${env.APP_URL}/api/auth/google/callback`;

export function googleAuthUrl(
  env: Env,
  opts: { state: string; drive: boolean; loginHint?: string },
): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: [...BASE_SCOPES, ...(opts.drive ? [DRIVE_SCOPE] : [])].join(" "),
    state: opts.state,
    include_granted_scopes: "true",
  });
  if (opts.drive) {
    // A refresh token is only issued with offline access, and only reliably with prompt=consent.
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  } else {
    params.set("prompt", "select_account");
  }
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
};

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new GoogleAuthError(`Google token request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export class GoogleAuthError extends Error {}

export function exchangeCode(env: Env, code: string) {
  return tokenRequest({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(env),
    grant_type: "authorization_code",
  });
}

export type GoogleProfile = { email: string; email_verified: boolean; name?: string; picture?: string };

export async function fetchProfile(accessToken: string): Promise<GoogleProfile> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new GoogleAuthError(`Google userinfo failed: ${res.status}`);
  return res.json();
}

/**
 * Verify a Google ID token from the mobile app's native sign-in. Its audience is our web client ID
 * (the app passes it as `webClientId`). Returns null if the token is invalid, expired or for another app.
 */
export async function verifyIdToken(env: Env, idToken: string): Promise<GoogleProfile | null> {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!res.ok) return null;
  const t = await res.json<{ aud: string; iss: string; exp: string; email?: string; email_verified?: string; name?: string; picture?: string }>();
  if (t.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (t.iss !== "accounts.google.com" && t.iss !== "https://accounts.google.com") return null;
  if (Number(t.exp) * 1000 < Date.now() || !t.email) return null;
  return { email: t.email, email_verified: t.email_verified === "true", name: t.name, picture: t.picture };
}

export async function saveDriveToken(env: Env, userId: string, refreshToken: string, scopes: string) {
  await env.DB.prepare(
    `INSERT INTO google_tokens (user_id, refresh_token_enc, scopes, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (user_id) DO UPDATE SET refresh_token_enc = ?2, scopes = ?3, updated_at = ?4`,
  )
    .bind(userId, await encrypt(refreshToken, env.TOKEN_ENC_KEY), scopes, Date.now())
    .run();
}

/** Returns a fresh Drive access token for the user, or null if they haven't connected Google Drive. */
export async function driveAccessToken(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT refresh_token_enc, scopes FROM google_tokens WHERE user_id = ?")
    .bind(userId)
    .first<{ refresh_token_enc: string; scopes: string }>();
  if (!row || !row.scopes.includes(DRIVE_SCOPE)) return null;
  try {
    const tok = await tokenRequest({
      refresh_token: await decrypt(row.refresh_token_enc, env.TOKEN_ENC_KEY),
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    });
    return tok.access_token;
  } catch (err) {
    // Revoked or expired grant: forget it so the user is asked to reconnect.
    console.warn("drive token refresh failed", err);
    await env.DB.prepare("DELETE FROM google_tokens WHERE user_id = ?").bind(userId).run();
    return null;
  }
}
