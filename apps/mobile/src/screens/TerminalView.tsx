import React, { useEffect, useMemo, useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useTheme } from '../theme-context';
import { terminalPageHtml } from './terminal-page';
import type { TerminalViewProps } from './terminal-types';

export type { TerminalViewProps };

const TerminalWebView = WebView as unknown as React.ComponentType<any>;

export function TerminalView({
  threadId,
  chunk,
  error,
  openPty,
  writePty,
  resizePty,
}: TerminalViewProps) {
  const { colors } = useTheme();
  const webRef = useRef<{ postMessage?: (data: string) => void } | null>(null);
  const sizeRef = useRef({ cols: 80, rows: 24 });
  const html = useMemo(() => terminalPageHtml(colors.bg, colors.text), [colors.bg, colors.text]);

  useEffect(() => {
    openPty(threadId, sizeRef.current.cols, sizeRef.current.rows);
  }, [threadId, openPty]);

  useEffect(() => {
    if (!chunk || chunk.threadId !== threadId || !chunk.data) return;
    webRef.current?.postMessage?.(JSON.stringify({ type: 'data', data: chunk.data }));
  }, [chunk, threadId]);

  return (
    <View style={styles.root}>
      {error ? (
        <Text selectable style={[styles.err, { color: '#ef4444' }]}>{error}</Text>
      ) : null}
      {Platform.OS === 'web' ? null : (
        <TerminalWebView
          ref={webRef}
          originWhitelist={['*']}
          source={{ html }}
          style={styles.web}
          onMessage={(event: { nativeEvent?: { data?: string } }) => {
            let msg: { type?: string; data?: string; cols?: number; rows?: number } = {};
            try { msg = JSON.parse(event?.nativeEvent?.data || '{}'); } catch { return; }
            if (msg.type === 'input' && msg.data) writePty(threadId, msg.data);
            if ((msg.type === 'resize' || msg.type === 'ready') && msg.cols && msg.rows) {
              sizeRef.current = { cols: msg.cols, rows: msg.rows };
              if (msg.type === 'ready') openPty(threadId, msg.cols, msg.rows);
              else resizePty(threadId, msg.cols, msg.rows);
            }
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 220 },
  web: { flex: 1, backgroundColor: 'transparent' },
  err: { fontSize: 12, paddingHorizontal: 8, paddingVertical: 6 },
});
