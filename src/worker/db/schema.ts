import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// All timestamps are unix epoch milliseconds.

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
  storageUsed: integer("storage_used").notNull().default(0),
  storageQuota: integer("storage_quota"), // bytes; null = the STORAGE_QUOTA_BYTES default
  theme: text("theme", { enum: ["system", "light", "dark"] }).notNull().default("system"),
  createdAt: integer("created_at").notNull(),
});

export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    invitedBy: text("invited_by").notNull().references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: integer("expires_at").notNull(),
    acceptedAt: integer("accepted_at"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("invites_email_idx").on(t.email)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha-256 of the cookie value
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const googleTokens = sqliteTable("google_tokens", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  scopes: text("scopes").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    parentId: text("parent_id"), // null = root of owner's My Files
    name: text("name").notNull(),
    isFolder: integer("is_folder", { mode: "boolean" }).notNull().default(false),
    mime: text("mime"),
    size: integer("size").notNull().default(0),
    currentVersionId: text("current_version_id"),
    thumbKey: text("thumb_key"),
    width: integer("width"),
    height: integer("height"),
    duration: integer("duration"), // seconds, for video/audio
    trashedAt: integer("trashed_at"),
    trashedBy: text("trashed_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    updatedBy: text("updated_by"),
  },
  (t) => [
    index("files_parent_idx").on(t.parentId),
    index("files_owner_idx").on(t.ownerId, t.parentId),
    index("files_trashed_idx").on(t.trashedAt),
    index("files_name_idx").on(t.name),
  ],
);

export const fileVersions = sqliteTable(
  "file_versions",
  {
    id: text("id").primaryKey(),
    fileId: text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull(),
    size: integer("size").notNull(),
    mime: text("mime"),
    source: text("source", { enum: ["upload", "copy", "google_saveback"] }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("file_versions_file_idx").on(t.fileId)],
);

export const stars = sqliteTable(
  "stars",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.fileId] })],
);

export const recents = sqliteTable(
  "recents",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    action: text("action", { enum: ["opened", "modified", "uploaded"] }).notNull(),
    at: integer("at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.fileId] }), index("recents_user_at_idx").on(t.userId, t.at)],
);

export const shares = sqliteTable(
  "shares",
  {
    fileId: text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "editor"] }).notNull(),
    sharedBy: text("shared_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.fileId, t.userId] }), index("shares_user_idx").on(t.userId)],
);

export const shareLinks = sqliteTable(
  "share_links",
  {
    token: text("token").primaryKey(),
    fileId: text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at"),
    disabledAt: integer("disabled_at"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("share_links_file_idx").on(t.fileId)],
);

export const googleLinks = sqliteTable(
  "google_links",
  {
    fileId: text("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    googleFileId: text("google_file_id").notNull(),
    googleMime: text("google_mime").notNull(),
    webViewLink: text("web_view_link").notNull(),
    sourceVersionId: text("source_version_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.fileId, t.userId] })],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["shared", "invite_accepted", "file_added", "google_saved"] }).notNull(),
    actorId: text("actor_id"),
    fileId: text("file_id"),
    payload: text("payload"), // JSON
    readAt: integer("read_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

export const uploads = sqliteTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    r2UploadId: text("r2_upload_id").notNull(),
    r2Key: text("r2_key").notNull(),
    fileId: text("file_id").notNull(),
    versionId: text("version_id").notNull(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    mime: text("mime"),
    size: integer("size").notNull(),
    partSize: integer("part_size").notNull(),
    status: text("status", { enum: ["pending", "completed", "aborted"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("uploads_file_idx").on(t.fileId), index("uploads_status_idx").on(t.status, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type FileRow = typeof files.$inferSelect;
