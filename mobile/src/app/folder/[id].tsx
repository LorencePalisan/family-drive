import { Stack, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { FileList } from "@/components/FileList";
import { DriveBottom } from "@/components/UploadControls";
import { useFolder } from "@/lib/queries";

export default function Folder() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useFolder(id);
  const canAdd = !!q.data && q.data.folder.role !== "viewer";
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: q.data?.folder.name ?? "" }} />
      <FileList
        items={q.data?.items}
        loading={q.isPending}
        error={q.error}
        refreshing={q.isRefetching}
        onRefresh={() => q.refetch()}
        empty={{ icon: "folder-open", title: "This folder is empty", body: canAdd ? "Tap New to add photos, videos or files." : undefined }}
      />
      <DriveBottom parentId={id} canAdd={canAdd} />
    </View>
  );
}
