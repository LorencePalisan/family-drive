import { newId } from "./crypto";

export type NotificationType = "shared" | "invite_accepted" | "file_added" | "google_saved" | "gsync_done";

export async function notify(
  env: Env,
  n: { userId: string; type: NotificationType; actorId?: string; fileId?: string; payload?: Record<string, unknown> },
) {
  await env.DB.prepare(
    "INSERT INTO notifications (id, user_id, type, actor_id, file_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(newId(), n.userId, n.type, n.actorId ?? null, n.fileId ?? null, n.payload ? JSON.stringify(n.payload) : null, Date.now())
    .run();
}
