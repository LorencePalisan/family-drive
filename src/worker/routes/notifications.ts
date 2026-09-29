import { Hono } from "hono";
import type { AppEnv } from "../types";

const notifications = new Hono<AppEnv>();

notifications.get("/", async (c) => {
  const me = c.get("user").id;
  const [list, unread] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT n.id, n.type, n.file_id AS fileId, n.payload, n.read_at AS readAt, n.created_at AS createdAt,
              a.name AS actorName, a.avatar_url AS actorAvatar, f.name AS fileName, f.is_folder AS isFolder
         FROM notifications n
         LEFT JOIN users a ON a.id = n.actor_id
         LEFT JOIN files f ON f.id = n.file_id
        WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 50`,
    ).bind(me),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").bind(me),
  ]);
  return c.json({
    items: (list.results as { payload: string | null; isFolder: number | null }[]).map((n) => ({
      ...n,
      isFolder: !!n.isFolder,
      payload: n.payload ? JSON.parse(n.payload) : null,
    })),
    unread: (unread.results[0] as { n: number }).n,
  });
});

notifications.post("/read", async (c) => {
  const body = await c.req.json<{ ids?: string[] }>().catch(() => ({}) as { ids?: string[] });
  const me = c.get("user").id;
  const now = Date.now();
  const ids = body.ids?.slice(0, 90);
  if (ids?.length) {
    await c.env.DB.prepare(
      `UPDATE notifications SET read_at = ? WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(now, me, ...ids)
      .run();
  } else {
    await c.env.DB.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").bind(now, me).run();
  }
  return c.json({ ok: true });
});

export default notifications;
