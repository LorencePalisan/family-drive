import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight } from "lucide-react";
import clsx from "clsx";
import type { DriveFile } from "../lib/types";
import { api } from "../lib/api";
import { Button, FileIcon, IconButton, Modal } from "./primitives";
import { useFileActions } from "./DriveUI";

type Loc = { id: string | null; name: string; root: "my" | "shared" };

export function MoveDialog({ files, onClose }: { files: DriveFile[]; onClose: () => void }) {
  const act = useFileActions();
  const [trail, setTrail] = useState<Loc[]>([{ id: null, name: "My Files", root: "my" }]);
  const loc = trail[trail.length - 1];
  const moving = new Set(files.map((f) => f.id));

  const q = useQuery({
    queryKey: ["drive", "move", loc.root, loc.id],
    queryFn: async () => {
      if (loc.id) return (await api<{ items: DriveFile[] }>(`/folders/${loc.id}`)).items;
      return (await api<{ items: DriveFile[] }>(loc.root === "my" ? "/drive/my" : "/drive/shared")).items;
    },
  });
  const folders = (q.data ?? []).filter((f) => f.isFolder && !moving.has(f.id) && (loc.id || loc.root === "my" || f.role !== "viewer"));
  const atSharedRoot = loc.root === "shared" && !loc.id;
  const isCurrent = files.every((f) => f.parentId === loc.id && (loc.id !== null || f.owner.isMe));
  const canMoveToRoot = loc.id !== null || files.every((f) => f.owner.isMe);

  return (
    <Modal open onOpenChange={onClose} title={files.length === 1 ? `Move "${files[0].name}"` : `Move ${files.length} items`} width={520}>
      <div className="mb-3 flex gap-2">
        {(["my", "shared"] as const).map((r) => (
          <button
            key={r}
            onClick={() => setTrail([{ id: null, name: r === "my" ? "My Files" : "Shared with me", root: r }])}
            className={clsx("h-8 rounded-lg border px-3 text-sm", trail[0].root === r ? "border-transparent bg-selected" : "border-line hover:bg-hover")}
          >
            {r === "my" ? "My Files" : "Shared with me"}
          </button>
        ))}
      </div>
      <div className="flex h-10 items-center gap-1 text-sm">
        {trail.length > 1 && (
          <IconButton label="Back" onClick={() => setTrail((t) => t.slice(0, -1))} className="size-8">
            <ArrowLeft size={18} />
          </IconButton>
        )}
        <span className="truncate font-medium">{loc.name}</span>
      </div>
      <ul className="h-72 overflow-auto rounded border border-line">
        {q.isLoading &&
          Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="flex h-11 items-center gap-3 px-3" aria-hidden>
              <div className="skeleton size-5" />
              <div className="skeleton h-3.5" style={{ width: `${35 + i * 9}%` }} />
            </li>
          ))}
        {!q.isLoading && folders.length === 0 && <li className="p-4 text-sm text-fg-2">No folders here</li>}
        {folders.map((f) => (
          <li key={f.id}>
            <button
              className="flex h-11 w-full items-center gap-3 px-3 text-left text-sm hover:bg-hover"
              onClick={() => setTrail((t) => [...t, { id: f.id, name: f.name, root: loc.root }])}
            >
              <FileIcon file={f} />
              <span className="flex-1 truncate">{f.name}</span>
              <ChevronRight size={18} className="text-fg-2" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="filled"
          disabled={atSharedRoot || isCurrent || !canMoveToRoot}
          onClick={() => {
            act.moveTo(files, loc.id, loc.name);
            onClose();
          }}
        >
          Move here
        </Button>
      </div>
    </Modal>
  );
}
