import { MaterialIcons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createFolder, useDriveMutation } from "@/lib/queries";
import { pickFiles, pickMedia, takePhoto } from "@/lib/pick";
import { useColors } from "@/lib/theme";
import { clearFinished, enqueue, onUploadFinished, retryUpload, useUploads, type UploadSource } from "@/lib/upload";
import { ActionSheet, PromptDialog } from "./Sheet";

const showError = (err: unknown) => Alert.alert("Couldn't do that", err instanceof Error ? err.message : String(err));

/**
 * Pinned to the bottom of a drive screen: the "+ New" button with the upload progress bar under it.
 * Tab screens pass `inTabs` because the tab bar already sits above the system navigation bar.
 */
export function DriveBottom({ parentId, inTabs = false, canAdd = true }: { parentId: string | null; inTabs?: boolean; canAdd?: boolean }) {
  const insets = useSafeAreaInsets();
  const c = useColors();
  const hasUploads = useUploads().length > 0;
  return (
    <View pointerEvents="box-none" style={styles.bottom}>
      {canAdd ? <NewButton parentId={parentId} /> : null}
      <UploadBar />
      {!inTabs ? <View pointerEvents="none" style={{ height: insets.bottom, backgroundColor: hasUploads ? c.surface : undefined }} /> : null}
    </View>
  );
}

/** The "+ New" floating button: upload photos/videos/files, take a photo, or create a folder in `parentId`. */
function NewButton({ parentId }: { parentId: string | null }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const newFolder = useDriveMutation((name: string) => createFolder(name, parentId));
  const add = (pick: () => Promise<UploadSource[]>) => () =>
    pick()
      .then((s) => s.length && enqueue(s, parentId))
      .catch(showError);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        android_ripple={{ color: c.selected, borderless: false }}
        style={[styles.fab, { backgroundColor: c.primarySoft }]}
        accessibilityLabel="New"
      >
        <MaterialIcons name="add" size={24} color={c.text} />
        <Text style={[styles.fabLabel, { color: c.text }]}>New</Text>
      </Pressable>
      <ActionSheet
        visible={open}
        title="Add to Family Drive"
        onClose={() => setOpen(false)}
        actions={[
          { label: "Upload photos & videos", icon: "photo-library", onPress: add(pickMedia) },
          { label: "Take a photo", icon: "photo-camera", onPress: add(takePhoto) },
          { label: "Upload files", icon: "upload-file", onPress: add(pickFiles) },
          { label: "New folder", icon: "create-new-folder", onPress: () => setNaming(true) },
        ]}
      />
      <PromptDialog
        visible={naming}
        title="New folder"
        initial="Untitled folder"
        confirmLabel="Create"
        onClose={() => setNaming(false)}
        onSubmit={(name) => newFolder.mutate(name, { onError: showError })}
      />
    </>
  );
}

/** A slim progress bar above the tab bar while uploads run; shows failures with a retry. */
function UploadBar() {
  const c = useColors();
  const qc = useQueryClient();
  const items = useUploads();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Batch list refreshes while many uploads finish in a row.
    onUploadFinished(() => {
      clearTimeout(timer);
      timer = setTimeout(() => qc.invalidateQueries(), 800);
    });
  }, [qc]);

  if (!items.length) return null;
  const active = items.filter((i) => i.status === "queued" || i.status === "uploading");
  const failed = items.filter((i) => i.status === "error");
  const total = items.reduce((a, i) => a + (i.status === "cancelled" ? 0 : i.size), 0);
  const loaded = items.reduce((a, i) => a + (i.status === "cancelled" ? 0 : i.loaded), 0);
  const pct = total ? Math.round((loaded / total) * 100) : 100;

  let label: string;
  if (active.length) label = `Uploading ${active.length} ${active.length === 1 ? "item" : "items"} · ${pct}%`;
  else if (failed.length) label = `${failed.length} ${failed.length === 1 ? "upload" : "uploads"} failed${failed[0].error ? `: ${failed[0].error}` : ""}`;
  else label = `${items.filter((i) => i.status === "done").length} uploads complete`;

  return (
    <View style={[styles.bar, { backgroundColor: c.surface, borderTopColor: c.border }]}>
      <View style={styles.barRow}>
        <MaterialIcons name={active.length ? "cloud-upload" : failed.length ? "error-outline" : "cloud-done"} size={20} color={failed.length && !active.length ? c.danger : c.primary} />
        <Text numberOfLines={1} style={[styles.barLabel, { color: c.text }]}>
          {label}
        </Text>
        {!active.length && failed.length ? (
          <Pressable hitSlop={8} onPress={() => failed.forEach((f) => retryUpload(f.id))}>
            <Text style={[styles.barAction, { color: c.primary }]}>Retry</Text>
          </Pressable>
        ) : null}
        {!active.length ? (
          <Pressable hitSlop={8} onPress={clearFinished} accessibilityLabel="Dismiss">
            <MaterialIcons name="close" size={20} color={c.text2} />
          </Pressable>
        ) : null}
      </View>
      {active.length ? (
        <View style={[styles.track, { backgroundColor: c.surface2 }]}>
          <View style={[styles.fill, { backgroundColor: c.primary, width: `${pct}%` }]} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0 },
  fab: {
    alignSelf: "flex-end",
    marginRight: 16,
    marginBottom: 16,
    height: 56,
    borderRadius: 16,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    elevation: 3,
    overflow: "hidden",
  },
  fabLabel: { fontSize: 15, fontWeight: "600" },
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  barLabel: { flex: 1, fontSize: 14 },
  barAction: { fontSize: 14, fontWeight: "600" },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4 },
});
