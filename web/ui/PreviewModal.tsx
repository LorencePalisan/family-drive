import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Info, MoreVertical, UserPlus } from "lucide-react";
import type { DriveFile } from "../lib/types";
import { api, downloadUrl } from "../lib/api";
import { fileKind, googleApp } from "../lib/format";
import { heicToDisplayable, isHeic } from "../lib/thumbs";
import { Button, FileIcon, IconButton } from "./primitives";
import { FileDropdown } from "./FileMenu";
import { useDriveUI, useFileActions, type PreviewState } from "./DriveUI";

const GOOGLE_LABEL = { docs: "Google Docs", sheets: "Google Sheets", slides: "Google Slides" } as const;

// The last few converted HEIC photos, so stepping back and forth between them doesn't decode again.
const heicCache = new Map<string, Promise<string>>();
const HEIC_CACHE_SIZE = 6;

function heicUrl(url: string, version: number): Promise<string> {
  const key = `${url}#${version}`;
  let p = heicCache.get(key);
  if (p) {
    heicCache.delete(key);
  } else {
    p = fetch(url)
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(heicToDisplayable)
      .then((b) => URL.createObjectURL(b));
    p.catch(() => heicCache.delete(key));
  }
  heicCache.set(key, p);
  for (const [k, old] of heicCache) {
    if (heicCache.size <= HEIC_CACHE_SIZE) break;
    heicCache.delete(k);
    old.then(URL.revokeObjectURL, () => {});
  }
  return p;
}

/** Chrome and Firefox can't show HEIC (iPhone photos), so it's converted in the browser; the thumbnail stands in meanwhile. */
function HeicImage({ state, url, onError }: { state: PreviewState; url: string; onError: () => void }) {
  const { file, source } = state;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    heicUrl(url, file.updatedAt).then(
      (u) => live && setSrc(u),
      () => live && onError(),
    );
    return () => {
      live = false;
    };
  }, [url, file.updatedAt, onError]);

  if (src) return <img key={file.id} src={src} alt={file.name} className="max-h-full max-w-full object-contain" />;
  return (
    <div className="relative flex max-h-full max-w-full items-center justify-center">
      {file.hasThumbnail && <img src={source.thumbnail(file)} alt="" className="max-h-[80vh] max-w-full object-contain opacity-60 blur-sm" />}
      <span role="status" className="absolute rounded-full bg-black/60 px-4 py-2 text-sm text-[#e3e3e3]">
        Loading photo…
      </span>
    </div>
  );
}

function Media({ state }: { state: PreviewState }) {
  const { file, source } = state;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [file.id]);
  const url = source.content(file);
  const kind = fileKind(file);
  const fail = useCallback(() => setFailed(true), []);

  if (!failed && kind === "image" && isHeic({ name: file.name, type: file.mime })) {
    return <HeicImage key={file.id} state={state} url={url} onError={fail} />;
  }
  if (!failed && kind === "image") {
    return <img key={file.id} src={url} alt={file.name} onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />;
  }
  if (!failed && kind === "video") {
    return (
      <video
        key={file.id}
        src={url}
        poster={file.hasThumbnail ? source.thumbnail(file) : undefined}
        controls
        autoPlay
        playsInline
        onError={() => setFailed(true)}
        className="max-h-full max-w-full bg-black"
      />
    );
  }
  if (!failed && kind === "audio") {
    return (
      <div className="flex flex-col items-center gap-6 rounded-2xl bg-[#2d2e30] p-10">
        <FileIcon file={file} size={72} />
        <audio key={file.id} src={url} controls autoPlay onError={() => setFailed(true)} />
      </div>
    );
  }
  if (kind === "pdf" || kind === "text") {
    return <iframe key={file.id} src={url} title={file.name} className="h-full w-full max-w-5xl rounded bg-white" />;
  }
  return <NoPreview state={state} reason={failed ? "This file can't be previewed in your browser." : undefined} />;
}

function NoPreview({ state, reason }: { state: PreviewState; reason?: string }) {
  const act = useFileActions();
  const app = googleApp(state.file.name);
  return (
    <div className="flex max-w-sm flex-col items-center gap-4 rounded-2xl bg-[#2d2e30] p-8 text-center text-[#e3e3e3]">
      {state.file.hasThumbnail ? (
        <img src={state.source.thumbnail(state.file)} alt="" className="max-h-48 rounded" />
      ) : (
        <FileIcon file={state.file} size={64} />
      )}
      <p className="text-lg">{reason ?? "No preview available"}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="filled" onClick={() => downloadUrl(state.source.content(state.file, true))}>
          <Download size={18} /> Download
        </Button>
        {app && !state.publicToken && (
          <Button variant="tonal" onClick={() => act.openInGoogle(state.file, app)}>
            Open with {GOOGLE_LABEL[app]}
          </Button>
        )}
      </div>
    </div>
  );
}

export function PreviewModal({ state, onChange, onClose }: { state: PreviewState; onChange: (s: PreviewState) => void; onClose: () => void }) {
  const ui = useDriveUI();
  const act = useFileActions();
  const { file, list } = state;
  const idx = list.findIndex((f) => f.id === file.id);
  const go = (d: number) => {
    const next = list[idx + d];
    if (next) onChange({ ...state, file: next });
  };
  const app = googleApp(file.name);

  useEffect(() => {
    if (!state.publicToken) api(`/files/${file.id}/opened`, { method: "POST" }).catch(() => {});
  }, [file.id, state.publicToken]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, video, audio, [role=menu]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-(--z-overlay) bg-black/85 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-0 z-(--z-overlay) flex flex-col text-[#e3e3e3] outline-none" aria-describedby={undefined}>
          <header className="flex h-16 shrink-0 items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-2 sm:px-4">
            <IconButton label="Close" onClick={onClose} className="text-[#e3e3e3] hover:bg-white/10">
              <ArrowLeft size={22} />
            </IconButton>
            <FileIcon file={file} />
            <Dialog.Title className="min-w-0 flex-1 truncate text-base font-normal">{file.name}</Dialog.Title>
            {app && !state.publicToken && (
              <button onClick={() => act.openInGoogle(file, app)} className="hidden h-9 items-center rounded-full bg-white/10 px-4 text-sm hover:bg-white/20 sm:flex">
                Open with {GOOGLE_LABEL[app]}
              </button>
            )}
            <IconButton label="Download" onClick={() => downloadUrl(state.source.content(file, true))} className="text-[#e3e3e3] hover:bg-white/10">
              <Download size={20} />
            </IconButton>
            {!state.publicToken && (
              <>
                <IconButton label="Share" onClick={() => ui.share(file)} className="text-[#e3e3e3] hover:bg-white/10 max-sm:hidden">
                  <UserPlus size={20} />
                </IconButton>
                <IconButton
                  label="Details"
                  onClick={() => {
                    onClose();
                    ui.setDetailsId(file.id);
                  }}
                  className="text-[#e3e3e3] hover:bg-white/10 max-sm:hidden"
                >
                  <Info size={20} />
                </IconButton>
                <FileDropdown
                  files={[file]}
                  list={list}
                  context="preview"
                  trigger={
                    <IconButton label="More actions" className="text-[#e3e3e3] hover:bg-white/10">
                      <MoreVertical size={20} />
                    </IconButton>
                  }
                />
              </>
            )}
          </header>
          <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-4 sm:px-16" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <Media state={state} />
            {idx > 0 && (
              <IconButton label="Previous" onClick={() => go(-1)} className="absolute left-2 size-12 bg-black/40 text-white hover:bg-black/60 max-sm:hidden">
                <ChevronLeft size={28} />
              </IconButton>
            )}
            {idx >= 0 && idx < list.length - 1 && (
              <IconButton label="Next" onClick={() => go(1)} className="absolute right-2 size-12 bg-black/40 text-white hover:bg-black/60 max-sm:hidden">
                <ChevronRight size={28} />
              </IconButton>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
