import { useState } from "react";
import { Alert } from "react-native";
import type { DriveFile } from "@shared/types";
import { downloadAndShare } from "@/lib/open";
import { renameFile, restoreFile, setStarred, trashFile, useDriveMutation } from "@/lib/queries";
import { ActionSheet, PromptDialog, type SheetAction } from "./Sheet";

const showError = (err: unknown) => Alert.alert("Something went wrong", err instanceof Error ? err.message : String(err));

/** The "⋮" menu for a file or folder. */
export function FileActions({ file, onClose }: { file: DriveFile | null; onClose: () => void }) {
  const [renaming, setRenaming] = useState<DriveFile | null>(null);
  const star = useDriveMutation((f: DriveFile) => setStarred(f, !f.starred));
  const rename = useDriveMutation(({ f, name }: { f: DriveFile; name: string }) => renameFile(f, name));
  const trash = useDriveMutation(trashFile);
  const restore = useDriveMutation(restoreFile);

  const actions: SheetAction[] = [];
  if (file) {
    const canEdit = file.role !== "viewer";
    if (file.trashedAt) {
      if (canEdit) actions.push({ label: "Restore", icon: "restore", onPress: () => restore.mutate(file, { onError: showError }) });
    } else {
      if (!file.isFolder) actions.push({ label: "Share or open with…", icon: "share", onPress: () => downloadAndShare(file).catch(showError) });
      actions.push({
        label: file.starred ? "Remove from Starred" : "Add to Starred",
        icon: file.starred ? "star" : "star-outline",
        onPress: () => star.mutate(file, { onError: showError }),
      });
      if (canEdit) {
        actions.push({ label: "Rename", icon: "edit", onPress: () => setRenaming(file) });
        actions.push({
          label: "Move to trash",
          icon: "delete-outline",
          destructive: true,
          onPress: () =>
            Alert.alert("Move to trash?", `"${file.name}" will be deleted forever after 30 days.`, [
              { text: "Cancel", style: "cancel" },
              { text: "Move to trash", style: "destructive", onPress: () => trash.mutate(file, { onError: showError }) },
            ]),
        });
      }
    }
  }

  return (
    <>
      <ActionSheet visible={!!file} title={file?.name} actions={actions} onClose={onClose} />
      <PromptDialog
        visible={!!renaming}
        title="Rename"
        initial={renaming?.name}
        onClose={() => setRenaming(null)}
        onSubmit={(name) => renaming && rename.mutate({ f: renaming, name }, { onError: showError })}
      />
    </>
  );
}
