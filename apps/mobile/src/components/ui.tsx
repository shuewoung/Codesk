import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable as NativePressable,
  Platform,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme-context';
import { radius } from '../theme';
import type { ConnKind } from '../types';
import { triggerHaptic } from '../utils/haptics';

/** Preserve caller state while making keyboard focus visible on web. */
export function AccessiblePressable({ style, onFocus, onBlur, accessibilityRole = 'button', ...props }: PressableProps) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  return <NativePressable {...props} accessibilityRole={accessibilityRole}
    onFocus={(event) => {
      const target = event.target as unknown as { matches?: (selector: string) => boolean };
      setFocused(Platform.OS !== 'web' || (target.matches?.(':focus-visible') ?? true));
      onFocus?.(event);
    }}
    onBlur={(event) => { setFocused(false); onBlur?.(event); }}
    style={(state) => [typeof style === 'function' ? style(state) : style,
      focused && (Platform.OS === 'web'
        ? { outlineColor: colors.text, outlineWidth: 2, outlineStyle: 'solid', outlineOffset: 2 } as ViewStyle
        : { borderColor: colors.text, borderWidth: 2 })]}
  />;
}
const Pressable = AccessiblePressable;

export function StatusPill({ kind, text }: { kind: ConnKind | 'idle'; text: string }) {
  const { colors } = useTheme();
  const tone =
    kind === 'connected' ? colors.ok : kind === 'hub_offline' ? colors.warn : colors.muted;
  const isOnline = kind === 'connected';

  return (
    <View style={[styles.pill, { borderColor: isOnline ? `${tone}40` : colors.line, backgroundColor: isOnline ? `${tone}10` : 'transparent' }]}>
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <Text style={[styles.pillText, { color: isOnline ? tone : colors.muted, fontWeight: isOnline ? '600' : '400' }]}>{text}</Text>
    </View>
  );
}

export function PrimaryButton({
  label,
  busy,
  danger,
  disabled,
  style,
  onPressIn,
  ...rest
}: PressableProps & { label: string; busy?: boolean; danger?: boolean; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();

  const handlePressIn = (e: GestureResponderEvent) => {
    if (!disabled && !busy) {
      triggerHaptic(danger ? 'medium' : 'light');
    }
    onPressIn?.(e);
  };

  return (
    <Pressable
      {...rest}
      accessibilityLabel={rest.accessibilityLabel || label}
      accessibilityState={{ ...rest.accessibilityState, disabled: !!(disabled || busy), busy: !!busy }}
      onPressIn={handlePressIn}
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
  disabled,
  busy,
  onPressIn,
  ...rest
}: PressableProps & { label: string; busy?: boolean; style?: StyleProp<ViewStyle> }) {
  const { colors } = useTheme();

  const handlePressIn = (e: GestureResponderEvent) => {
    if (!disabled && !busy) triggerHaptic('light');
    onPressIn?.(e);
  };

  return (
    <Pressable
      {...rest}
      accessibilityLabel={rest.accessibilityLabel || label}
      accessibilityState={{ ...rest.accessibilityState, disabled: !!(disabled || busy), busy: !!busy }}
      disabled={disabled || busy}
      onPressIn={handlePressIn}
      style={({ pressed }) => [
        styles.btn,
        styles.btnGhost,
        (disabled || busy) && styles.btnDisabled,
        { borderColor: colors.line, backgroundColor: colors.shell },
        pressed && styles.btnPressed,
        style,
      ]}
    >
      <Text style={[styles.ghostLabel, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

export function EmptyState({ title, detail, busy }: { title: string; detail?: string; busy?: boolean }) {
  const { colors } = useTheme();
  return (
    <View accessibilityLiveRegion="polite" style={styles.empty}>
      <View style={[styles.emptyIconCircle, { backgroundColor: colors.shell, borderColor: colors.line }]}>
        {busy ? <ActivityIndicator color={colors.text} /> : <Text style={{ fontSize: 24 }}>💬</Text>}
      </View>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>{title}</Text>
      {detail ? <Text style={[styles.emptyDetail, { color: colors.muted }]}>{detail}</Text> : null}
    </View>
  );
}

export function ErrorBanner({ text, onClose }: { text: string; onClose?: () => void }) {
  const { colors } = useTheme();
  if (!text) return null;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.error,
        { backgroundColor: `${colors.danger}15`, borderColor: `${colors.danger}40` },
        pressed && { opacity: 0.8 },
      ]}
      accessibilityLabel={onClose ? `关闭提示：${text}` : text}
      accessibilityLiveRegion="polite"
      onPress={onClose}
    >
      <Text style={{ color: colors.danger, fontSize: 13, marginRight: 6 }}>⚠</Text>
      <Text style={[styles.errorText, { color: colors.danger, flex: 1 }]}>{text}</Text>
      {onClose ? <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '700', paddingHorizontal: 4 }}>✕</Text> : null}
    </Pressable>
  );
}

export function FeedbackBanner({ text, onClose }: { text: string; onClose?: () => void }) {
  const { colors } = useTheme();
  if (!text) return null;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.error,
        { backgroundColor: `${colors.ok}14`, borderColor: `${colors.ok}40` },
        pressed && { opacity: 0.8 },
      ]}
      accessibilityLabel={onClose ? `关闭提示：${text}` : text}
      accessibilityLiveRegion="polite"
      onPress={onClose}
    >
      <Text style={{ color: colors.ok, fontSize: 13, marginRight: 6 }}>✓</Text>
      <Text style={[styles.errorText, { color: colors.text, flex: 1 }]}>{text}</Text>
      {onClose ? <Text style={{ color: colors.muted, fontSize: 13, fontWeight: '700', paddingHorizontal: 4 }}>✕</Text> : null}
    </Pressable>
  );
}

export function PlusCircleOutlineIcon({ size = 15, color }: { size?: number; color?: string }) {
  const { colors } = useTheme();
  const c = color || colors.muted;
  const lineLen = Math.round(size * 0.48);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1.3,
        borderColor: c,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View style={{ width: lineLen, height: 1.3, backgroundColor: c }} />
      <View style={{ width: 1.3, height: lineLen, backgroundColor: c, position: 'absolute' }} />
    </View>
  );
}

export function FolderOutlineIcon({ size = 15, color, open = false }: { size?: number; color?: string; open?: boolean }) {
  const { colors } = useTheme();
  const c = color || colors.muted;
  return (
    <View style={{ width: size + 2, height: size, justifyContent: 'flex-end' }}>
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
  btnGhost: { borderWidth: 1 },
  btnDisabled: { opacity: 0.4 },
  btnPressed: {
    opacity: 0.88,
    transform: [{ scale: 0.98 }],
  },
  btnLabel: { fontSize: 16, fontWeight: '600' },
  ghostLabel: { fontSize: 15, fontWeight: '500' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: { fontSize: 19, fontWeight: '600', marginBottom: 8 },
  emptyDetail: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  error: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: 10,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  errorText: { fontSize: 13, lineHeight: 18 },
});
