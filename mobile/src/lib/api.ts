import * as SecureStore from "expo-secure-store";
import type { DriveFile } from "@shared/types";
import { API_URL } from "./config";

const TOKEN_KEY = "session_token";

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export async function loadToken(): Promise<string | null> {
  token = await SecureStore.getItemAsync(TOKEN_KEY);
  return token;
}

export async function saveToken(value: string | null) {
  token = value;
  if (value) await SecureStore.setItemAsync(TOKEN_KEY, value);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

/** Called when the server rejects the session (expired or signed out elsewhere). */
export function setUnauthorizedHandler(cb: (() => void) | null) {
  onUnauthorized = cb;
}

export const authHeaders = (): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`${API_URL}/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: { ...authHeaders(), ...(opts.body !== undefined && { "content-type": "application/json" }) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized?.();
    const err = data as { error?: string; code?: string } | null;
    throw new ApiError(res.status, err?.error ?? `Request failed (${res.status})`, err?.code);
  }
  return data as T;
}

/** Image/video sources carry the Bearer token as a header (expo-image and expo-video both support headers). */
export const contentSource = (f: Pick<DriveFile, "id">) => ({ uri: `${API_URL}/api/files/${f.id}/content`, headers: authHeaders() });
export const thumbnailSource = (f: Pick<DriveFile, "id">) => ({ uri: `${API_URL}/api/files/${f.id}/thumbnail`, headers: authHeaders() });
