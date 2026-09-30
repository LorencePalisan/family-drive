import { View } from "react-native";
import { FileList } from "@/components/FileList";
import { DriveBottom } from "@/components/UploadControls";
import { useView } from "@/lib/queries";

export default function Starred() {
  const q = useView("starred");
  return (
    <View style={{ flex: 1 }}>
      <FileList
        items={q.data}
        loading={q.isPending}
        error={q.error}
        refreshing={q.isRefetching}
        onRefresh={() => q.refetch()}
        empty={{ icon: "star-outline", title: "No starred files", body: "Star things you want to find quickly." }}
      />
      <DriveBottom parentId={null} inTabs canAdd={false} />
    </View>
  );
}
