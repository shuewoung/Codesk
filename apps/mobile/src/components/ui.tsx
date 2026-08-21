import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme-context';
import { radius } from '../theme';
import type { ConnKind } from '../types';

export function StatusPill({ kind, text }: { kind: ConnKind | 'idle'; text: string }) {
  const { colors } = useTheme();
  const tone =
    kind === 'connected' ? colors.ok : kind === 'hub_offline' ? colors.warn : colors.muted;
  return (
    <View style={[styles.pill, { borderColor: colors.line }]}>
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <Text style={[styles.pillText, { color: colors.muted }]}>{text}</Text>
    </View>
  );
}

export function PrimaryButton({
  label,
  busy,
  danger,
  disabled,
  style,
  ...rest
}: PressableProps & { label: string; busy?: boolean; danger?: boolean; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return (
    <Pressable
      {...rest}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: danger ? colors.danger : colors.send },
        (disabled || busy) && styles.btnDisabled,
        pressed && styles.btnPressed,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.sendText} />
      ) : (
        <Text style={[styles.btnLabel, { color: danger ? '#fff' : colors.sendText }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function GhostButton({
  label,
  style,
  ...rest
}: PressableProps & { label: string; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();
  return (
    <Pressable
      {...rest}
      style={({ pressed }) => [styles.btn, styles.btnGhost, { borderColor: colors.line }, pressed && styles.btnPressed, style]}
    >
      <Text style={[styles.ghostLabel, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>{title}</Text>
      {detail ? <Text style={[styles.emptyDetail, { color: colors.muted }]}>{detail}</Text> : null}
    </View>
  );
}

export function ErrorBanner({ text, onClose }: { text: string; onClose?: () => void }) {
  const { colors } = useTheme();
  if (!text) return null;
  return (
    <Pressable style={[styles.error, { backgroundColor: colors.shell, borderColor: colors.danger }]} onPress={onClose}>
      <Text style={[styles.errorText, { color: colors.danger }]}>{text}</Text>
    </Pressable>
  );
}

export function FolderOutlineIcon({ size = 15, color, open = false }: { size?: number; color?: string; open?: boolean }) {
  const { colors } = useTheme();
  const c = color || colors.muted;
  return (
    <View style={{ width: size + 2, height: size, justifyContent: 'flex-end', marginRight: 6 }}>
      <View
        style={{
          width: size * 0.46,
          height: size * 0.32,
          borderTopWidth: 1.3,
          borderLeftWidth: 1.3,
          borderRightWidth: 1.3,
          borderColor: c,
          borderTopLeftRadius: 2,
          borderTopRightRadius: 2,
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      />
      <View
        style={{
          width: size + 2,
          height: size * 0.74,
          borderWidth: 1.3,
          borderColor: c,
          borderRadius: 2.5,
          backgroundColor: 'transparent',
          transform: open ? [{ skewX: '-8deg' }] : [],
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    gap: 6,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 12 },
  btn: {
    minHeight: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1 },
  btnDisabled: { opacity: 0.4 },
  btnPressed: { opacity: 0.85 },
  btnLabel: { fontSize: 16, fontWeight: '600' },
  ghostLabel: { fontSize: 15, fontWeight: '500' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 20, fontWeight: '600', marginBottom: 8 },
  emptyDetail: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  error: {
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: 10,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  errorText: { fontSize: 13 },
});
