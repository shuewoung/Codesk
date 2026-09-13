import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme-context';
import type { TerminalViewProps } from './terminal-types';

export function TerminalView({
  threadId,
  chunk,
  error,
  openPty,
  writePty,
  resizePty,
}: TerminalViewProps) {
  const { colors } = useTheme();
  const hostRef = useRef<View>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastChunk = useRef(0);

  useEffect(() => {
    const raw = hostRef.current as unknown as { _nativeNode?: HTMLElement; getNode?: () => HTMLElement } | HTMLElement | null;
    const node = !raw
      ? null
      : raw instanceof HTMLElement
        ? raw
        : (raw._nativeNode instanceof HTMLElement ? raw._nativeNode : raw.getNode?.() || null);
    if (!node) return undefined;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: {
        background: colors.bg,
        foreground: colors.text,
        cursor: colors.text,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);
    termRef.current = term;
    fitRef.current = fit;
    const onData = term.onData((data) => writePty(threadId, data));
    const applyFit = () => {
      try { fit.fit(); } catch { /* ignore */ }
      resizePty(threadId, term.cols, term.rows);
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(applyFit) : null;
    ro?.observe(node);
    const t = setTimeout(() => {
      applyFit();
      openPty(threadId, term.cols, term.rows);
    }, 30);
    return () => {
      clearTimeout(t);
      ro?.disconnect();
      onData.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [threadId, colors.bg, colors.text, openPty, writePty, resizePty]);

  useEffect(() => {
    if (!chunk || chunk.threadId !== threadId || !chunk.data) return;
    if (chunk.n === lastChunk.current) return;
    lastChunk.current = chunk.n;
    termRef.current?.write(chunk.data);
  }, [chunk, threadId]);

  return (
    <View style={styles.root}>
      {error ? (
        <Text selectable style={[styles.err, { color: '#ef4444' }]}>{error}</Text>
      ) : null}
      <View ref={hostRef} collapsable={false} style={styles.host} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 240 },
  host: { flex: 1, width: '100%' },
  err: { fontSize: 12, paddingHorizontal: 8, paddingVertical: 6 },
});
