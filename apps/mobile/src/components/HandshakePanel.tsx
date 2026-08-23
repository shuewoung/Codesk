import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { HandshakeView } from '../handshake';
import { useTheme } from '../theme-context';

const STALE_MS = 10000;

const MARK: Record<string, string> = {
  ok: '✓',
  now: '●',
  fail: '!',
  skip: '–',
  wait: '○',
};

export function HandshakePanel({
  handshake,
  onRetry,
  retryLabel,
}: {
  handshake: HandshakeView;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  const { colors } = useTheme();
  const [stale, setStale] = useState(false);

  useEffect(() => {
    setStale(false);
    if (!handshake.active || handshake.needsRetry) return;
    const timer = setTimeout(() => setStale(true), STALE_MS);
    return () => clearTimeout(timer);
  }, [handshake.active, handshake.phase, handshake.needsRetry]);

  if (!handshake.active) return null;
  const showRetry = Boolean(onRetry) && (handshake.needsRetry || stale);
  return (
    <View style={[styles.wrap, { backgroundColor: colors.bg, borderColor: colors.line }]}>
      <Text style={[styles.title, { color: colors.text }]}>{handshake.title}</Text>
      {handshake.detail ? (
        <Text style={[styles.detail, { color: colors.muted }]}>{handshake.detail}</Text>
      ) : null}
      <View style={styles.steps}>
        {handshake.steps.map((step) => (
          <View key={step.key} style={styles.row}>
            <Text style={{
              width: 16,
              color: step.state === 'ok' ? colors.ok : step.state === 'fail' ? colors.danger : step.state === 'now' ? colors.text : colors.muted,
              fontWeight: '700',
            }}>
              {MARK[step.state] || '○'}
            </Text>
            <Text style={{ color: step.state === 'wait' ? colors.muted : colors.text, fontSize: 13 }}>
              {step.label}
            </Text>
          </View>
        ))}
      </View>
      {showRetry ? (
        <Pressable onPress={onRetry} style={[styles.retry, { backgroundColor: colors.text }]}>
          <Text style={{ color: colors.bg, fontWeight: '700', fontSize: 14 }}>{retryLabel || '重试'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  title: { fontSize: 15, fontWeight: '700' },
  detail: { fontSize: 12, lineHeight: 18 },
  steps: { gap: 6, paddingTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  retry: { marginTop: 6, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
});
