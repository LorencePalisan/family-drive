import type { Role } from "../types";
import { fail } from "../types";

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export type FileRecord = {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  is_folder: number;
  mime: string | null;
  size: number;
  current_version_id: string | null;
  thumb_key: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  trashed_at: number | null;
  trashed_by: string | null;
  created_at: number;
  updated_at: number;
  updated_by: string | null;
};

/**
 * Effective role of a user on a file:
 * - owner of the file → owner
 * - owner of any ancestor folder → editor (things others added to your folders)
 * - best share on the file or any ancestor → editor / viewer
 */
export async function getAccess(env: Env, fileId: string, userId: string): Promise<{ file: FileRecord; role: Role | null } | null> {
  const [fileRes, accRes] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(fileId),
    env.DB.prepare(
      `WITH RECURSIVE anc(id, parent_id, owner_id) AS (
         SELECT id, parent_id, owner_id FROM files WHERE id = ?1
         UNION ALL
         SELECT f.id, f.parent_id, f.owner_id FROM files f JOIN anc ON f.id = anc.parent_id
       )
       SELECT
         EXISTS (SELECT 1 FROM anc WHERE owner_id = ?2) AS owns_ancestor,
         (SELECT MAX(CASE s.role WHEN 'editor' THEN 2 ELSE 1 END) FROM shares s
           WHERE s.user_id = ?2 AND s.file_id IN (SELECT id FROM anc)) AS share_rank`,
    ).bind(fileId, userId),
  ]);
  const file = fileRes.results[0] as FileRecord | undefined;
  if (!file) return null;
  const acc = accRes.results[0] as { owns_ancestor: number; share_rank: number | null };
  let role: Role | null = null;
  if (file.owner_id === userId) role = "owner";
  else if (acc.owns_ancestor || acc.share_rank === 2) role = "editor";
  else if (acc.share_rank === 1) role = "viewer";
  return { file, role };
}

export const atLeast = (role: Role | null, min: Role) => role !== null && RANK[role] >= RANK[min];

/** Load a file and assert the user has at least `min` access. Hides existence (404) when there is no access at all. */
export async function requireAccess(
  env: Env,
  fileId: string,
  userId: string,
  min: Role,
  opts: { allowTrashed?: boolean } = {},
): Promise<{ file: FileRecord; role: Role }> {
  const res = await getAccess(env, fileId, userId);
  if (!res || !res.role) return fail(404, "File not found");
  if (res.file.trashed_at && !opts.allowTrashed) return fail(404, "File is in the trash");
  if (!atLeast(res.role, min)) return fail(403, `You need ${min} access to do that`);
  return { file: res.file, role: res.role };
}

/** Destination folder check for uploads, new folders, moves and copies. null = the user's own My Files root. */
export async function requireWritableFolder(env: Env, folderId: string | null | undefined, userId: string) {
  if (!folderId) return null;
  const { file } = await requireAccess(env, folderId, userId, "editor");
  if (!file.is_folder) fail(400, "Destination is not a folder");
  return file;
}

/** IDs of a file plus all of its descendants. */
export async function descendantIds(env: Env, rootId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE d(id) AS (SELECT ?1 UNION ALL SELECT f.id FROM files f JOIN d ON f.parent_id = d.id) SELECT id FROM d`,
  )
    .bind(rootId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** True if `candidateId` is `ancestorId` or somewhere below it. */
export async function isWithin(env: Env, candidateId: string, ancestorId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `WITH RECURSIVE anc(id, parent_id) AS (
       SELECT id, parent_id FROM files WHERE id = ?1
       UNION ALL SELECT f.id, f.parent_id FROM files f JOIN anc ON f.id = anc.parent_id
     ) SELECT EXISTS (SELECT 1 FROM anc WHERE id = ?2) AS inside`,
  )
    .bind(candidateId, ancestorId)
    .first<{ inside: number }>();
  return !!row?.inside;
}

/**
 * Access for the non-trashed files matching `where` (over alias f; ?1 = user id), resolved bottom-up:
 * each candidate walks up its non-trashed ancestors (stopping above the first folder the user owns)
 * and keeps the best grant seen. Rows read scale with candidates × folder depth, not with the size
 * of the drive, which is what keeps D1 usage flat as the family's library grows.
 * Yields a(id, rnk, prnk): rnk = best rank (3 = owner-level, 2 = editor, 1 = viewer), prnk = the parent's.
 */
const accessCte = (where: string, candTail = "") => `
  WITH RECURSIVE cand(id) AS (SELECT f.id FROM files f WHERE f.trashed_at IS NULL AND (${where}) ${candTail}),
  up(fid, id, parent_id, owner_id, depth) AS (
    SELECT f.id, f.id, f.parent_id, f.owner_id, 0 FROM cand JOIN files f ON f.id = cand.id
    UNION ALL
    SELECT up.fid, p.id, p.parent_id, p.owner_id, up.depth + 1
      FROM up JOIN files p ON p.id = up.parent_id
     WHERE p.trashed_at IS NULL AND (up.depth = 0 OR up.owner_id <> ?1) AND up.depth < 64
  ),
  graded(fid, depth, rk) AS (
    SELECT fid, depth, CASE WHEN owner_id = ?1 THEN 3 ELSE COALESCE(
      (SELECT CASE s.role WHEN 'editor' THEN 2 ELSE 1 END FROM shares s WHERE s.file_id = up.id AND s.user_id = ?1), 0) END
      FROM up
  ),
  a(id, rnk, prnk) AS (
    SELECT fid, MAX(rk), MAX(CASE WHEN depth > 0 THEN rk ELSE 0 END) FROM graded GROUP BY fid HAVING MAX(rk) > 0
  )`;

const LIST_COLUMNS = `
  f.*, a.rnk,
  u.name AS owner_name, u.email AS owner_email, u.avatar_url AS owner_avatar,
  CASE WHEN a.prnk > 0 THEN p.name END AS parent_name,
  st.user_id IS NOT NULL AS starred,
  (EXISTS (SELECT 1 FROM shares sh WHERE sh.file_id = f.id)
    OR EXISTS (SELECT 1 FROM share_links l WHERE l.file_id = f.id AND l.disabled_at IS NULL)) AS is_shared,
  r.action AS recent_action, r.at AS recent_at`;

const LIST_JOINS = `
  FROM a JOIN files f ON f.id = a.id
  JOIN users u ON u.id = f.owner_id
  LEFT JOIN files p ON p.id = f.parent_id
  LEFT JOIN stars st ON st.file_id = f.id AND st.user_id = ?1
  LEFT JOIN recents r ON r.file_id = f.id AND r.user_id = ?1`;

type ListRow = FileRecord & {
  rnk: number;
  owner_name: string;
  owner_email: string;
  owner_avatar: string | null;
  parent_name: string | null;
  starred: number;
  is_shared: number;
  recent_action: string | null;
  recent_at: number | null;
};

export type FileDTO = ReturnType<typeof toDTO>;

export function toDTO(row: ListRow, userId: string) {
  const role: Role = row.owner_id === userId ? "owner" : row.rnk >= 2 ? "editor" : "viewer";
  const location =
    row.parent_id && row.parent_name != null
      ? { id: row.parent_id, name: row.parent_name }
      : row.owner_id === userId
        ? { id: null, name: "My Files" }
        : { id: null, name: "Shared with me" };
  return {
    id: row.id,
    name: row.name,
    isFolder: !!row.is_folder,
    mime: row.mime,
    size: row.size,
    parentId: row.parent_id,
    location,
    owner: { id: row.owner_id, name: row.owner_name, email: row.owner_email, avatarUrl: row.owner_avatar, isMe: row.owner_id === userId },
    role,
    starred: !!row.starred,
    shared: !!row.is_shared,
    hasThumbnail: !!row.thumb_key,
    width: row.width,
    height: row.height,
    duration: row.duration,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trashedAt: row.trashed_at,
    recent: row.recent_action ? { action: row.recent_action, at: row.recent_at } : null,
  };
}

/**
 * List accessible files matching `where`. `where` may only use alias f (plus subqueries); keep it selective
 * (an indexed column or an `f.id IN (...)` list), since every match is access-checked. `orderBy` may also
 * use a, st and r. Extra bind params start at ?2.
 */
export async function listAccessible(
  env: Env,
  userId: string,
  opts: { where: string; params?: unknown[]; orderBy?: string; limit?: number },
) {
  const sql = `${accessCte(opts.where)} SELECT ${LIST_COLUMNS} ${LIST_JOINS}
    ORDER BY ${opts.orderBy ?? "f.is_folder DESC, f.name COLLATE NOCASE"}
    LIMIT ${Math.min(opts.limit ?? 500, 1000)}`;
  const { results } = await env.DB.prepare(sql)
    .bind(userId, ...(opts.params ?? []))
    .all<ListRow>();
  return results.map((r) => toDTO(r, userId));
}

export const PAGE_SIZE = 500;

type Cursor = { f: 0 | 1; n: string; i: string };
const encodeCursor = (c: Cursor) => btoa(encodeURIComponent(JSON.stringify(c)));
function decodeCursor(raw: string | undefined): Cursor {
  if (!raw) return { f: 1, n: "", i: "" };
  try {
    const c = JSON.parse(decodeURIComponent(atob(raw))) as Cursor;
    if ((c.f === 0 || c.f === 1) && typeof c.n === "string" && typeof c.i === "string") return c;
  } catch {}
  return fail(400, "Invalid cursor");
}

/**
 * One page of a folder-style listing (folders first, then files, by name). Only for `where`s whose matches
 * are all accessible once the parent is (a folder's children, the user's own root), since the page is cut
 * before the access check. Keyset-paged within each is_folder group so each page reads ~`size` index
 * entries (files_list_idx) instead of rescanning the folder.
 */
export async function listPage(env: Env, userId: string, opts: { where: string; params?: unknown[]; cursor?: string; size?: number }) {
  const size = Math.min(opts.size ?? PAGE_SIZE, 1000);
  let cur = decodeCursor(opts.cursor);
  const items: FileDTO[] = [];
  for (;;) {
    const want = size - items.length;
    const p = 2 + (opts.params?.length ?? 0);
    const order = "f.name COLLATE NOCASE, f.id";
    const sql = `${accessCte(
      // COLLATE goes on the cursor value: written on f.name, SQLite can't seek the index to the cursor.
      `(${opts.where}) AND f.is_folder = ?${p} AND (f.name, f.id) > (?${p + 1} COLLATE NOCASE, ?${p + 2})`,
      `ORDER BY ${order} LIMIT ${want + 1}`,
    )} SELECT ${LIST_COLUMNS} ${LIST_JOINS} ORDER BY ${order}`;
    const { results } = await env.DB.prepare(sql)
      .bind(userId, ...(opts.params ?? []), cur.f, cur.n, cur.i)
      .all<ListRow>();
    items.push(...results.slice(0, want).map((r) => toDTO(r, userId)));
    if (results.length > want) {
      const last = items[items.length - 1];
      return { items, nextCursor: encodeCursor({ f: cur.f, n: last.name, i: last.id }) };
    }
    if (cur.f === 0) return { items, nextCursor: null };
    // Folders are exhausted; fill the rest of the page with files.
    cur = { f: 0, n: "", i: "" };
    if (items.length === size) return { items, nextCursor: encodeCursor(cur) };
  }
}

/** Single-file DTO (after an access check has already passed). */
export async function fileDTO(env: Env, fileId: string, userId: string) {
  const [dto] = await listAccessible(env, userId, { where: "f.id = ?2", params: [fileId], limit: 1 });
  return dto ?? null;
}

/** Items in the user's trash: trashed by them or owned by them, showing only the top-most trashed item. */
export async function listTrash(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    `SELECT f.*, CASE WHEN f.owner_id = ?1 THEN 3 ELSE 2 END AS rnk,
            u.name AS owner_name, u.email AS owner_email, u.avatar_url AS owner_avatar,
            p.name AS parent_name, 0 AS starred, 0 AS is_shared, NULL AS recent_action, NULL AS recent_at
       FROM files f
       JOIN users u ON u.id = f.owner_id
       LEFT JOIN files p ON p.id = f.parent_id
      WHERE f.trashed_at IS NOT NULL
        AND (f.owner_id = ?1 OR f.trashed_by = ?1)
        AND (p.id IS NULL OR p.trashed_at IS NULL OR p.trashed_at <> f.trashed_at)
      ORDER BY f.trashed_at DESC
      LIMIT 1000`,
  )
    .bind(userId)
    .all<ListRow>();
  return results.map((r) => toDTO(r, userId));
}
