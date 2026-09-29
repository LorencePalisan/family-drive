import type { ContentSource } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
    signal: opts.signal,
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !location.pathname.startsWith("/login") && !location.pathname.startsWith("/s/")) {
      location.href = `/login?return=${encodeURIComponent(location.pathname + location.search)}`;
    }
    throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? res.statusText);
  }
  return data as T;
}

export const driveSource: ContentSource = {
  content: (f, download) => `/api/files/${f.id}/content${download ? "?download=1" : ""}`,
  thumbnail: (f) => `/api/files/${f.id}/thumbnail`,
};

export const publicSource = (token: string): ContentSource => ({
  content: (f, download) => `/api/public/${token}/content?fileId=${f.id}${download ? "&download=1" : ""}`,
  thumbnail: (f) => `/api/public/${token}/thumbnail?fileId=${f.id}`,
});

/** Trigger a browser download without navigating away. */
export function downloadUrl(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
