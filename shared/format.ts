import type { DriveFile } from "./types";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() && { year: "numeric" }) });
}

export const formatDateTime = (ms: number) =>
  new Date(ms).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function timeAgo(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return formatDate(ms);
}

export type Kind = "folder" | "image" | "video" | "audio" | "pdf" | "doc" | "sheet" | "slides" | "archive" | "text" | "file";

export function fileKind(f: Pick<DriveFile, "isFolder" | "mime" | "name">): Kind {
  if (f.isFolder) return "folder";
  const m = f.mime ?? "";
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (m.startsWith("image/") || ["heic", "heif"].includes(ext)) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (/(word|opendocument\.text|rtf)/.test(m) || ["doc", "docx", "odt", "rtf"].includes(ext)) return "doc";
  if (/(excel|spreadsheet|csv)/.test(m) || ["xls", "xlsx", "csv", "ods", "tsv"].includes(ext)) return "sheet";
  if (/(powerpoint|presentation)/.test(m) || ["ppt", "pptx", "odp"].includes(ext)) return "slides";
  if (/(zip|compressed|tar|gzip|rar)/.test(m)) return "archive";
  if (m.startsWith("text/")) return "text";
  return "file";
}

export const KIND_LABEL: Record<Kind, string> = {
  folder: "Folder",
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF",
  doc: "Document",
  sheet: "Spreadsheet",
  slides: "Presentation",
  archive: "Archive",
  text: "Text",
  file: "File",
};

/** Which Google editor can open this file (mirrors the worker's googleAppFor). */
export function googleApp(name: string): "docs" | "sheets" | "slides" | null {
  if (/\.(docx?|odt|rtf|txt|html?|pdf)$/i.test(name)) return "docs";
  if (/\.(xlsx?|xlsm|ods|csv|tsv)$/i.test(name)) return "sheets";
  if (/\.(pptx?|odp)$/i.test(name)) return "slides";
  return null;
}

export const canPreview = (f: DriveFile) => ["image", "video", "audio", "pdf", "text"].includes(fileKind(f));
