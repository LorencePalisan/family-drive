import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  ArrowUpRight,
  ChevronRight,
  Copy,
  Download,
  Eye,
  FolderInput,
  Info,
  Link,
  Pencil,
  RotateCcw,
  Star,
  StarOff,
  Trash2,
  UserPlus,
  FileText,
  Sheet,
  Presentation,
  CloudDownload,
  UserMinus,
} from "lucide-react";
import type { ReactNode } from "react";
import type { DriveFile } from "../lib/types";
import { canPreview, googleApp } from "../lib/format";
import { useDriveUI, useFileActions } from "./DriveUI";
import { useMe } from "./useMe";

const DD = {
  Item: DropdownMenu.Item,
  Sub: DropdownMenu.Sub,
  SubTrigger: DropdownMenu.SubTrigger,
  SubContent: DropdownMenu.SubContent,
  Separator: DropdownMenu.Separator,
  Portal: DropdownMenu.Portal,
};
type Kit = typeof DD;
const CM = {
  Item: ContextMenu.Item,
  Sub: ContextMenu.Sub,
  SubTrigger: ContextMenu.SubTrigger,
  SubContent: ContextMenu.SubContent,
  Separator: ContextMenu.Separator,
  Portal: ContextMenu.Portal,
} as unknown as Kit;

export type MenuContext = "drive" | "trash" | "shared" | "preview";

const GOOGLE_APPS = {
  docs: { label: "Google Docs", Icon: FileText, color: "#4285f4" },
  sheets: { label: "Google Sheets", Icon: Sheet, color: "#0f9d58" },
  slides: { label: "Google Slides", Icon: Presentation, color: "#f4b400" },
} as const;

function MItem({ kit: K, icon, children, onSelect, disabled }: { kit: Kit; icon: ReactNode; children: ReactNode; onSelect: () => void; disabled?: boolean }) {
  return (
    <K.Item className="menu-item" onSelect={onSelect} disabled={disabled}>
      {icon}
      {children}
    </K.Item>
  );
}

function MSub({ kit: K, icon, label, children }: { kit: Kit; icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <K.Sub>
      <K.SubTrigger className="menu-item">
        {icon}
        <span className="flex-1">{label}</span>
        <ChevronRight />
      </K.SubTrigger>
      <K.Portal>
        <K.SubContent className="menu" sideOffset={2}>
          {children}
        </K.SubContent>
      </K.Portal>
    </K.Sub>
  );
}

function GoogleIcon({ app }: { app: keyof typeof GOOGLE_APPS }) {
  const G = GOOGLE_APPS[app];
  return <G.Icon color={G.color} />;
}

function MenuItems({ kit: K, files, list, context }: { kit: Kit; files: DriveFile[]; list: DriveFile[]; context: MenuContext }) {
  const ui = useDriveUI();
  const act = useFileActions();
  const me = useMe().data;
  const single = files.length === 1 ? files[0] : null;
  const canEdit = files.every((f) => f.role !== "viewer");
  const allStarred = files.every((f) => f.starred);

  if (context === "trash") {
    return (
      <>
        <MItem kit={K} icon={<RotateCcw />} onSelect={() => act.restore(files)}>
          Restore
        </MItem>
        <MItem kit={K} icon={<Trash2 />} onSelect={() => act.deleteForever(files)} disabled={!files.every((f) => f.owner.isMe)}>
          Delete forever
        </MItem>
      </>
    );
  }

  const app = single && !single.isFolder ? googleApp(single.name) : null;
  return (
    <>
      {single && !single.isFolder && context !== "preview" && (
        <MSub kit={K} icon={<ArrowUpRight />} label="Open with">
          <MItem kit={K} icon={<Eye />} onSelect={() => act.open(single, list)}>
            {canPreview(single) ? "Preview" : "Open"}
          </MItem>
          {app && (
            <>
              <K.Separator className="menu-sep" />
              <MItem kit={K} icon={<GoogleIcon app={app} />} onSelect={() => act.openInGoogle(single, app)}>
                {GOOGLE_APPS[app].label}
              </MItem>
              {single.role !== "viewer" && (
                <MItem kit={K} icon={<CloudDownload />} onSelect={() => act.saveFromGoogle(single)}>
                  Save changes from {GOOGLE_APPS[app].label}
                </MItem>
              )}
            </>
          )}
        </MSub>
      )}
      {single && !single.isFolder && context === "preview" && app && (
        <>
          <MItem kit={K} icon={<GoogleIcon app={app} />} onSelect={() => act.openInGoogle(single, app)}>
            Open with {GOOGLE_APPS[app].label}
          </MItem>
          {single.role !== "viewer" && (
            <MItem kit={K} icon={<CloudDownload />} onSelect={() => act.saveFromGoogle(single)}>
              Save changes from {GOOGLE_APPS[app].label}
            </MItem>
          )}
        </>
      )}
      <MItem kit={K} icon={<Download />} onSelect={() => act.download(files)}>
        Download
      </MItem>
      {single && (
        <MItem kit={K} icon={<Pencil />} onSelect={() => ui.rename(single)} disabled={!canEdit}>
          Rename
        </MItem>
      )}
      {files.every((f) => !f.isFolder) && (
        <MItem kit={K} icon={<Copy />} onSelect={() => act.makeCopy(files)}>
          Make a copy
        </MItem>
      )}
      <K.Separator className="menu-sep" />
      {single && (
        <MSub kit={K} icon={<UserPlus />} label="Share">
          <MItem kit={K} icon={<UserPlus />} onSelect={() => ui.share(single)}>
            Share
          </MItem>
          <MItem kit={K} icon={<Link />} onSelect={() => act.copyLink(single)}>
            Copy link
          </MItem>
        </MSub>
      )}
      <MSub kit={K} icon={<FolderInput />} label="Organize">
        <MItem kit={K} icon={<FolderInput />} onSelect={() => ui.move(files)} disabled={!canEdit}>
          Move
        </MItem>
        <MItem kit={K} icon={allStarred ? <StarOff /> : <Star />} onSelect={() => act.star(files, !allStarred)}>
          {allStarred ? "Remove from starred" : "Add to starred"}
        </MItem>
      </MSub>
      {single && (
        <MSub kit={K} icon={<Info />} label="File information">
          <MItem kit={K} icon={<Info />} onSelect={() => ui.setDetailsId(single.id)}>
            Details
          </MItem>
        </MSub>
      )}
      <K.Separator className="menu-sep" />
      {context === "shared" && single && !single.owner.isMe && me && (
        <MItem kit={K} icon={<UserMinus />} onSelect={() => act.removeFromShared(single, me.id)}>
          Remove from Shared with me
        </MItem>
      )}
      <MItem kit={K} icon={<Trash2 />} onSelect={() => act.trash(files)} disabled={!canEdit}>
        Move to trash
      </MItem>
    </>
  );
}

export function FileDropdown({ files, list, context, trigger, align = "end" }: { files: DriveFile[]; list: DriveFile[]; context: MenuContext; trigger: ReactNode; align?: "start" | "end" }) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align={align} sideOffset={4} collisionPadding={8} onClick={(e) => e.stopPropagation()}>
          <MenuItems kit={DD} files={files} list={list} context={context} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function FileContextMenu({ files, list, context, children, onOpenChange }: { files: DriveFile[]; list: DriveFile[]; context: MenuContext; children: ReactNode; onOpenChange?: (open: boolean) => void }) {
  return (
    <ContextMenu.Root modal={false} onOpenChange={onOpenChange}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu" collisionPadding={8}>
          <MenuItems kit={CM} files={files} list={list} context={context} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
