import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSession } from '../session';
import { radius, space } from '../theme';
import { useTheme } from '../theme-context';
import type { TreeNode } from '../types';

function collectDirs(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.type === 'directory') {
      out.push(n.path);
      if (n.children) collectDirs(n.children, out);
    }
  }
  return out;
}

function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  if (!q) return nodes;
  const lower = q.toLowerCase();
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.type === 'file') {
      if (n.name.toLowerCase().includes(lower) || n.path.toLowerCase().includes(lower)) {
        out.push(n);
      }
    } else if (n.type === 'directory') {
      const filteredChildren = n.children ? filterTree(n.children, q) : [];
      if (filteredChildren.length || n.name.toLowerCase().includes(lower)) {
        out.push({ ...n, children: filteredChildren });
      }
    }
  }
  return out;
}

export function FilePanel({
  threadId,
  onOpenFile,
}: {
  threadId?: string;
  onOpenFile: (path: string) => void;
}) {
  const session = useSession();
  const { colors } = useTheme();
  const history = threadId ? session.histories[threadId] : undefined;
  const cwd = history?.cwd || session.projects[0]?.cwd || '';
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filterQ, setFilterQ] = useState('');

  useEffect(() => {
    if (threadId) session.requestTree(threadId, cwd);
  }, [threadId, cwd]);

  const displayedTree = useMemo(() => filterTree(session.tree.tree, filterQ.trim()), [session.tree.tree, filterQ]);
  const dirs = useMemo(() => collectDirs(displayedTree), [displayedTree]);

  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const d of dirs) next[d] = true;
    setOpen(next);
  }, [session.tree.cwd, dirs.length, filterQ]);

  const accountLeft = session.quota.primaryUsedPercent != null
    ? Math.max(0, 100 - session.quota.primaryUsedPercent)
    : null;
  const ctxLeft = history?.tokenUsage?.usedPercent != null
    ? Math.max(0, 100 - history.tokenUsage.usedPercent)
    : history?.tokenUsage?.primaryUsedPercent != null
      ? Math.max(0, 100 - history.tokenUsage.primaryUsedPercent)
      : accountLeft;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Text style={[styles.head, { color: colors.text }]}>文件</Text>
      <Text style={[styles.cwd, { color: colors.muted }]} numberOfLines={2}>
        {session.tree.rootName || cwd || '当前工作目录'}
      </Text>
      <View style={{ paddingHorizontal: space.md, paddingBottom: 8 }}>
        <TextInput
          value={filterQ}
          onChangeText={setFilterQ}
          placeholder="🔍 筛选文件..."
          placeholderTextColor={colors.muted}
          style={[styles.searchInput, { backgroundColor: colors.shell, color: colors.text, borderColor: colors.line }]}
        />
      </View>
      <View style={styles.actions}>
        <Pressable style={[styles.chip, { backgroundColor: colors.shell }]} onPress={() => {
          const next: Record<string, boolean> = {};
          for (const d of dirs) next[d] = true;
          setOpen(next);
        }}>
          <Text style={{ color: colors.text, fontSize: 13 }}>全部展开</Text>
        </Pressable>
        <Pressable style={[styles.chip, { backgroundColor: colors.shell }]} onPress={() => setOpen({})}>
          <Text style={{ color: colors.text, fontSize: 13 }}>全部折叠</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        {displayedTree.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            open={open}
            onToggle={(p) => setOpen((prev) => ({ ...prev, [p]: !prev[p] }))}
            onOpenFile={onOpenFile}
          />
        ))}
        {!displayedTree.length ? (
          <Text style={{ color: colors.muted, padding: space.md }}>没有可显示的文件</Text>
        ) : null}
      </ScrollView>
      <View style={[styles.bars, { borderTopColor: colors.line }]}>
        <UsageBar label="账号剩余" value={accountLeft} color={colors.ok} track={colors.shell} text={colors.muted} />
        <UsageBar label="上下文剩余" value={ctxLeft} color={colors.warn} track={colors.shell} text={colors.muted} />
      </View>
    </View>
  );
}

function TreeRow({
  node,
  depth,
  open,
  onToggle,
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
  open: Record<string, boolean>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const { colors } = useTheme();
  if (node.type === 'directory') {
    const expanded = !!open[node.path];
    return (
      <View>
        <Pressable
          onPress={() => onToggle(node.path)}
          style={[styles.folder, { backgroundColor: colors.shell, marginLeft: 10 + depth * 12 }]}
        >
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>
            {expanded ? '▾  文件夹' : '▸  文件夹'}  {node.name}
          </Text>
        </Pressable>
        {expanded
          ? (node.children || []).map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                open={open}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
              />
            ))
          : null}
      </View>
    );
  }
  return (
    <Pressable
      onPress={() => onOpenFile(node.path)}
      style={{ paddingLeft: 22 + depth * 12, paddingVertical: 10, paddingRight: 12 }}
    >
      <Text style={{ color: colors.text, fontSize: 15 }}>📄  {node.name}</Text>
    </Pressable>
  );
}

function UsageBar({
  label,
  value,
  color,
  track,
  text,
}: {
  label: string;
  value: number | null;
  color: string;
  track: string;
  text: string;
}) {
  return (
    <View style={styles.barRow}>
      <Text style={{ color: text, fontSize: 11, width: 72 }}>{label}</Text>
      <View style={[styles.barTrack, { backgroundColor: track }]}>
        <View style={[styles.barFill, { width: `${value ?? 0}%`, backgroundColor: color }]} />
      </View>
      <Text style={{ color: text, fontSize: 11, width: 36, textAlign: 'right' }}>
        {value == null ? '--' : `${value}%`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: { fontSize: 18, fontWeight: '700', paddingHorizontal: space.md, paddingTop: space.md },
  cwd: { fontSize: 12, paddingHorizontal: space.md, paddingBottom: 8 },
  searchInput: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8, fontSize: 14 },
  actions: { flexDirection: 'row', gap: 8, paddingHorizontal: space.md, paddingBottom: 8 },
  chip: { borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  list: { paddingBottom: space.md },
  folder: { marginRight: 10, marginBottom: 4, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 10 },
  bars: { paddingHorizontal: space.md, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, gap: 6 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barTrack: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },
});
