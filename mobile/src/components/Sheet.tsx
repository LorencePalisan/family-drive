import { MaterialIcons } from "@expo/vector-icons";
import { useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/lib/theme";

export type SheetAction = {
  label: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  onPress: () => void;
  destructive?: boolean;
};

/** A bottom sheet with a title and a list of actions (Android-style modal bottom sheet). */
export function ActionSheet({ visible, title, header, actions, onClose }: { visible: boolean; title?: string; header?: ReactNode; actions: SheetAction[]; onClose: () => void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: c.surface, paddingBottom: insets.bottom + 8 }]}>
        <View style={[styles.handle, { backgroundColor: c.border }]} />
        {header}
        {title ? (
          <Text numberOfLines={1} style={[styles.title, { color: c.text }]}>
            {title}
          </Text>
        ) : null}
        {actions.map((a) => (
          <Pressable
            key={a.label}
            android_ripple={{ color: c.selected }}
            style={styles.action}
            onPress={() => {
              onClose();
              a.onPress();
            }}
          >
            <MaterialIcons name={a.icon} size={22} color={a.destructive ? c.danger : c.text2} />
            <Text style={[styles.actionLabel, { color: a.destructive ? c.danger : c.text }]}>{a.label}</Text>
          </Pressable>
        ))}
      </View>
    </Modal>
  );
}

/** A small text-input dialog (Alert.prompt is iOS-only). */
export function PromptDialog({
  visible,
  title,
  initial = "",
  confirmLabel = "OK",
  onSubmit,
  onClose,
}: {
  visible: boolean;
  title: string;
  initial?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const c = useColors();
  const [value, setValue] = useState(initial);
  const submit = () => {
    if (!value.trim()) return;
    onClose();
    onSubmit(value.trim());
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} onShow={() => setValue(initial)} statusBarTranslucent>
      <View style={[styles.scrim, styles.center]}>
        <View style={[styles.dialog, { backgroundColor: c.surface }]}>
          <Text style={[styles.dialogTitle, { color: c.text }]}>{title}</Text>
          <TextInput
            autoFocus
            value={value}
            onChangeText={setValue}
            onSubmitEditing={submit}
            selectTextOnFocus
            style={[styles.input, { color: c.text, borderColor: c.primary }]}
          />
          <View style={styles.dialogButtons}>
            <Pressable onPress={onClose} style={styles.textButton}>
              <Text style={[styles.textButtonLabel, { color: c.primary }]}>Cancel</Text>
            </Pressable>
            <Pressable onPress={submit} style={styles.textButton}>
              <Text style={[styles.textButtonLabel, { color: c.primary }]}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: "#0b1f1a66" },
  center: { justifyContent: "center", alignItems: "center", padding: 24 },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: 8 },
  handle: { alignSelf: "center", width: 32, height: 4, borderRadius: 2, marginBottom: 8 },
  title: { fontSize: 16, fontWeight: "500", paddingHorizontal: 24, paddingVertical: 12 },
  action: { flexDirection: "row", alignItems: "center", gap: 20, paddingHorizontal: 24, height: 52 },
  actionLabel: { fontSize: 16 },
  dialog: { width: "100%", maxWidth: 420, borderRadius: 28, padding: 24 },
  dialogTitle: { fontSize: 22, marginBottom: 16 },
  input: { borderWidth: 2, borderRadius: 4, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  dialogButtons: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 20 },
  textButton: { paddingHorizontal: 12, paddingVertical: 10 },
  textButtonLabel: { fontSize: 14, fontWeight: "600" },
});
