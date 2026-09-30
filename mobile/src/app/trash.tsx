import { View } from "react-native";
import { FileList } from "@/components/FileList";
import { useView } from "@/lib/queries";

export default function Trash() {
  const q = useView("trash");
  return (
    <View style={{ flex: 1 }}>
      <FileList
        items={q.data}
        loading={q.isPending}
        error={q.error}
        refreshing={q.isRefetching}
        onRefresh={() => q.refetch()}
        empty={{ icon: "delete-outline", title: "Trash is empty", body: "Items in the trash are deleted forever after 30 days." }}
      />
    </View>
  );
}
