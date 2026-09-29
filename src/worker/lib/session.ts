import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { AppEnv } from "../types";
import type { User } from "../db/schema";
import { randomToken, sha256 } from "./crypto";

const COOKIE = "sid";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const secure = (c: Context) => new URL(c.req.url).protocol === "https:";

export async function createSession(c: Context<AppEnv>, userId: string) {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now + SESSION_TTL_MS, now)
    .run();
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: secure(c),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(c: Context<AppEnv>) {
  const token = getCookie(c, COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256(token)).run();
  deleteCookie(c, COOKIE, { path: "/" });
}

export async function loadUser(c: Context<AppEnv>): Promise<User | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.avatar_url AS avatarUrl, u.role, u.storage_used AS storageUsed, u.theme, u.created_at AS createdAt
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(await sha256(token), Date.now())
    .first<User>();
  return row ?? null;
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await loadUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  c.set("user", user);
  await next();
};

export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("user").role !== "owner") return c.json({ error: "Only the drive owner can do that" }, 403);
  await next();
};
