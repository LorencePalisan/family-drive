export type Role = "owner" | "editor" | "viewer";

export interface Person {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface DriveFile {
  id: string;
  name: string;
  isFolder: boolean;
  mime: string | null;
  size: number;
  parentId: string | null;
  location: { id: string | null; name: string };
  owner: Person & { isMe: boolean };
  role: Role;
  starred: boolean;
  shared: boolean;
  hasThumbnail: boolean;
  width: number | null;
  height: number | null;
  duration: number | null;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  recent: { action: "opened" | "modified" | "uploaded"; at: number } | null;
}

export interface FileDetails extends DriveFile {
  updatedByName: string | null;
  versions: { id: string; size: number; source: string; createdAt: number; createdBy: string }[];
}

export interface Me extends Person {
  role: "owner" | "member";
  storageUsed: number;
  storageQuota: number;
  theme: "system" | "light" | "dark";
  googleDriveConnected: boolean;
  appName: string;
}

export interface Notification {
  id: string;
  type: "shared" | "invite_accepted" | "file_added" | "google_saved";
  fileId: string | null;
  fileName: string | null;
  isFolder: boolean;
  actorName: string | null;
  actorAvatar: string | null;
  payload: { role?: string; message?: string; folderName?: string } | null;
  readAt: number | null;
  createdAt: number;
}

export interface AccessInfo {
  owner: Person;
  members: (Person & { role: "viewer" | "editor"; inheritedFrom: string | null })[];
  links: { token: string; url: string; expiresAt: number | null }[];
  canShare: boolean;
}

/** Where a file's bytes come from: signed-in API or a public share link. */
export interface ContentSource {
  content: (f: Pick<DriveFile, "id">, download?: boolean) => string;
  thumbnail: (f: Pick<DriveFile, "id">) => string;
}
