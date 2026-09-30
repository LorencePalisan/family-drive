import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DriveFile, FileDetails, Me } from "@shared/types";
import { api } from "./api";

export type ViewName = "my" | "recent" | "starred" | "shared" | "trash";

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/me") });

export const useHome = () =>
  useQuery({ queryKey: ["home"], queryFn: () => api<{ folders: DriveFile[]; files: DriveFile[] }>("/drive/home") });

export const useView = (view: ViewName) =>
  useQuery({ queryKey: ["view", view], queryFn: () => api<{ items: DriveFile[] }>(`/drive/${view}`).then((r) => r.items) });

export const useFolder = (id: string) =>
  useQuery({
    queryKey: ["folder", id],
    queryFn: () => api<{ folder: DriveFile; path: { id: string | null; name: string }[]; items: DriveFile[] }>(`/folders/${id}`),
  });

export const useFile = (id: string) => useQuery({ queryKey: ["file", id], queryFn: () => api<FileDetails>(`/files/${id}`) });

export const useSearch = (q: string, type: string) =>
  useQuery({
    queryKey: ["search", q, type],
    queryFn: () => api<{ items: DriveFile[] }>(`/drive/search?${new URLSearchParams({ q, type })}`).then((r) => r.items),
    enabled: q.trim().length > 0 || type !== "",
    placeholderData: (prev) => prev,
  });

/** Any change can show up in several lists (home, folder, starred, search), so refresh them all. */
export function useDriveMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries() });
}

export const setStarred = (f: DriveFile, starred: boolean) => api(`/files/${f.id}/star`, { method: "PUT", body: { starred } });
export const renameFile = (f: DriveFile, name: string) => api<DriveFile>(`/files/${f.id}`, { method: "PATCH", body: { name } });
export const trashFile = (f: DriveFile) => api(`/files/${f.id}/trash`, { method: "POST" });
export const restoreFile = (f: DriveFile) => api(`/files/${f.id}/restore`, { method: "POST" });
export const createFolder = (name: string, parentId: string | null) => api<DriveFile>("/folders", { body: { name, parentId } });
