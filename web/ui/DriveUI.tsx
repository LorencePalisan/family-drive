import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, driveSource, downloadUrl } from "../lib/api";
import type { ContentSource, DriveFile } from "../lib/types";
import { Button, Modal, inputClass, useToast } from "./primitives";
import { ShareDialog } from "./ShareDialog";
import { MoveDialog } from "./MoveDialog";
import { PreviewModal } from "./PreviewModal";

export type PreviewState = { file: DriveFile; list: DriveFile[]; source: ContentSource; publicToken?: string };
type ConfirmOpts = { title: string; body: ReactNode; confirmLabel: string };
type View = "list" | "grid";

interface DriveUIValue {
  preview: PreviewState | null;
  openPreview: (p: PreviewState) => void;
  closePreview: () => void;
  detailsId: string | null;
  setDetailsId: (id: string | null) => void;
  rename: (f: DriveFile) => void;
  share: (f: DriveFile) => void;
  move: (files: DriveFile[]) => void;
  newFolder: (parentId: string | null) => void;
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  view: View;
  setView: (v: View) => void;
}

const Ctx = createContext<DriveUIValue | null>(null);
export const useDriveUI = () => useContext(Ctx)!;

function readView(): View {
  try {
    return localStorage.getItem("view") === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function DriveUIProvider({ children }: { children: ReactNode }) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<DriveFile | null>(null);
  const [sharing, setSharing] = useState<DriveFile | null>(null);
  const [moving, setMoving] = useState<DriveFile[] | null>(null);
  const [folderParent, setFolderParent] = useState<string | null | undefined>(undefined);
  const [confirmState, setConfirmState] = useState<(ConfirmOpts & { resolve: (ok: boolean) => void }) | null>(null);
  const [view, setViewState] = useState<View>(readView);

  const setView = useCallback((v: View) => {
    setViewState(v);
    try {
      localStorage.setItem("view", v);
    } catch {
      /* private mode */
    }
  }, []);

  const value = useMemo<DriveUIValue>(
    () => ({
      preview,
      openPreview: setPreview,
      closePreview: () => setPreview(null),
      detailsId,
      setDetailsId,
      rename: setRenaming,
      share: setSharing,
      move: setMoving,
      newFolder: (p) => setFolderParent(p),
      confirm: (o) => new Promise<boolean>((resolve) => setConfirmState({ ...o, resolve })),
      view,
      setView,
    }),
    [preview, detailsId, view, setView],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {renaming && <RenameDialog file={renaming} onClose={() => setRenaming(null)} />}
      {folderParent !== undefined && <NewFolderDialog parentId={folderParent} onClose={() => setFolderParent(undefined)} />}
      {sharing && <ShareDialog file={sharing} onClose={() => setSharing(null)} />}
      {moving && <MoveDialog files={moving} onClose={() => setMoving(null)} />}
      {preview && <PreviewModal state={preview} onChange={setPreview} onClose={() => setPreview(null)} />}
      {confirmState && (
        <Modal
          open
          onOpenChange={() => {
            confirmState.resolve(false);
            setConfirmState(null);
          }}
          title={confirmState.title}
        >
          <div className="text-sm text-fg-2">{confirmState.body}</div>
          <div className="mt-6 flex justify-end gap-2">
            <Button
              onClick={() => {
                confirmState.resolve(false);
                setConfirmState(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                confirmState.resolve(true);
                setConfirmState(null);
              }}
            >
              {confirmState.confirmLabel}
            </Button>
          </div>
        </Modal>
      )}
    </Ctx.Provider>
  );
}

function NameForm({ initial, label, onSubmit, onClose, selectBase }: { initial: string; label: string; onSubmit: (name: string) => Promise<void>; onClose: () => void; selectBase?: boolean }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        try {
          await onSubmit(name.trim());
          onClose();
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}
    >
      <input
        ref={ref}
        data-autofocus
        data-select-end={selectBase && initial.lastIndexOf(".") > 0 ? initial.lastIndexOf(".") : initial.length}
        className={inputClass}
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label={label}
      />
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-6 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={busy || !name.trim()}>
          {label === "Folder name" ? "Create" : "OK"}
        </Button>
      </div>
    </form>
  );
}

function RenameDialog({ file, onClose }: { file: DriveFile; onClose: () => void }) {
  const qc = useQueryClient();
  return (
    <Modal open onOpenChange={onClose} title="Rename" width={380}>
      <NameForm
        initial={file.name}
        label="New name"
        selectBase={!file.isFolder}
        onClose={onClose}
        onSubmit={async (name) => {
          await api(`/files/${file.id}`, { method: "PATCH", body: { name } });
          await qc.invalidateQueries({ queryKey: ["drive"] });
        }}
      />
    </Modal>
  );
}

function NewFolderDialog({ parentId, onClose }: { parentId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  return (
    <Modal open onOpenChange={onClose} title="New folder" width={380}>
      <NameForm
        initial="Untitled folder"
        label="Folder name"
        onClose={onClose}
        onSubmit={async (name) => {
          await api("/folders", { body: { name, parentId } });
          await qc.invalidateQueries({ queryKey: ["drive"] });
        }}
      />
    </Modal>
  );
}

/** Every action the file menus, toolbar and keyboard shortcuts can trigger. */
export function useFileActions() {
  const ui = useDriveUI();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["drive"] });
    qc.invalidateQueries({ queryKey: ["file"] });
    qc.invalidateQueries({ queryKey: ["me"] });
  }, [qc]);

  const guard = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        toast((err as Error).message);
      } finally {
        refresh();
      }
    },
    [toast, refresh],
  );

  return useMemo(
    () => ({
      refresh,
      open(file: DriveFile, list: DriveFile[] = [file]) {
        if (file.isFolder) return navigate(`/folders/${file.id}`);
        ui.openPreview({ file, list: list.filter((f) => !f.isFolder), source: driveSource });
      },
      download(files: DriveFile[]) {
        for (const f of files) downloadUrl(f.isFolder ? `/api/files/${f.id}/zip` : driveSource.content(f, true));
        if (files.length > 1) toast(`Downloading ${files.length} items`);
      },
      openInGoogle(file: DriveFile, app: "docs" | "sheets" | "slides") {
        window.open(`/api/files/${file.id}/open-in-google?app=${app}`, "_blank", "noopener");
      },
      saveFromGoogle: (file: DriveFile) =>
        guard(async () => {
          await api(`/files/${file.id}/save-from-google`, { method: "POST" });
          toast(`Saved the Google version of "${file.name}"`);
        }),
      copyLink: (file: DriveFile) =>
        guard(async () => {
          if (file.role === "viewer") {
            await navigator.clipboard.writeText(`${location.origin}/${file.isFolder ? "folders" : "file"}/${file.id}`);
            toast("Link copied (only people with access can open it)");
            return;
          }
          const { url } = await api<{ url: string }>(`/files/${file.id}/links`, { method: "POST", body: {} });
          await navigator.clipboard.writeText(url);
          toast("Link copied. Anyone with the link can view.");
        }),
      makeCopy: (files: DriveFile[]) =>
        guard(async () => {
          for (const f of files.filter((x) => !x.isFolder)) await api(`/files/${f.id}/copy`, { method: "POST", body: {} });
          toast(files.length === 1 ? `Created "Copy of ${files[0].name}"` : `Copied ${files.length} files`);
        }),
      star: (files: DriveFile[], starred: boolean) =>
        guard(async () => {
          await Promise.all(files.map((f) => api(`/files/${f.id}/star`, { method: "PUT", body: { starred } })));
        }),
      trash: (files: DriveFile[]) =>
        guard(async () => {
          await Promise.all(files.map((f) => api(`/files/${f.id}/trash`, { method: "POST" })));
          ui.setDetailsId(null);
          toast(files.length === 1 ? `"${files[0].name}" moved to trash` : `${files.length} items moved to trash`, {
            label: "Undo",
            run: () => guard(() => Promise.all(files.map((f) => api(`/files/${f.id}/restore`, { method: "POST" })))),
          });
        }),
      restore: (files: DriveFile[]) =>
        guard(async () => {
          await Promise.all(files.map((f) => api(`/files/${f.id}/restore`, { method: "POST" })));
          toast(files.length === 1 ? `"${files[0].name}" restored` : `${files.length} items restored`);
        }),
      deleteForever: async (files: DriveFile[]) => {
        const ok = await ui.confirm({
          title: "Delete forever?",
          body: `${files.length === 1 ? `"${files[0].name}"` : `${files.length} items`} will be deleted forever and you won't be able to restore ${files.length === 1 ? "it" : "them"}.`,
          confirmLabel: "Delete forever",
        });
        if (ok) await guard(() => Promise.all(files.map((f) => api(`/files/${f.id}`, { method: "DELETE" }))));
      },
      removeFromShared: (file: DriveFile, myId: string) =>
        guard(async () => {
          await api(`/files/${file.id}/shares/${myId}`, { method: "DELETE" });
          toast(`Removed "${file.name}" from Shared with me`);
        }),
      moveTo: (files: DriveFile[], parentId: string | null, parentName: string) =>
        guard(async () => {
          await Promise.all(files.map((f) => api(`/files/${f.id}`, { method: "PATCH", body: { parentId } })));
          toast(files.length === 1 ? `Moved "${files[0].name}" to ${parentName}` : `Moved ${files.length} items to ${parentName}`);
        }),
    }),
    [ui, toast, navigate, guard, refresh],
  );
}
