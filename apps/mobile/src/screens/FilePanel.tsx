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

export type FileIconInfo = {
  text: string;
  color?: string;
  isBadge?: boolean;
};

export function getFileIconInfo(filename: string): FileIconInfo {
  const lower = filename.toLowerCase();

  // 1. Exact / Special Filenames
  if (lower === '.gitignore' || lower === '.gitmodules' || lower === '.gitattributes') {
    return { text: '◆', color: '#f05032' };
  }
  if (lower.startsWith('readme') || lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')) {
    return { text: 'ℹ', color: '#38bdf8' };
  }
  if (lower === 'package.json' || lower === 'package-lock.json' || lower === 'pnpm-lock.yaml' || lower === 'yarn.lock' || lower === 'bun.lockb') {
    return { text: '⬢', color: '#ef4444' };
  }
  if (lower.startsWith('license') || lower.startsWith('licence')) {
    return { text: '⚖', color: '#eab308' };
  }
  if (lower === 'dockerfile' || lower.startsWith('docker-compose')) {
    return { text: '🐳', color: '#38bdf8' };
  }

  // 2. Extensions
  if (/\.(png|jpg|jpeg|gif|webp|svg|ico|bmp|avif)$/i.test(lower)) {
    return { text: '🖼', color: '#c084fc' };
  }
  if (/\.(html|htm)$/i.test(lower)) {
    return { text: '🌐', color: '#f97316' };
  }
  if (/\.(css|scss|sass|less)$/i.test(lower)) {
    return { text: '🎨', color: '#38bdf8' };
  }
  if (/\.(tsx|ts)$/i.test(lower)) {
    return { text: 'TS', color: '#3b82f6', isBadge: true };
  }
  if (/\.(jsx|js|mjs|cjs)$/i.test(lower)) {
    return { text: 'JS', color: '#eab308', isBadge: true };
  }
  if (/\.(json|json5|jsonc)$/i.test(lower)) {
    return { text: '{}', color: '#f59e0b', isBadge: true };
  }
  if (/\.(yaml|yml|toml|ini|cfg|conf|config|env|env\..*)$/i.test(lower)) {
    return { text: '⚙', color: '#94a3b8' };
  }
  if (/\.(py|pyw|ipynb)$/i.test(lower)) {
    return { text: '🐍', color: '#3b82f6' };
  }
  if (/\.(rs)$/i.test(lower)) {
    return { text: '🦀', color: '#f97316' };
  }
  if (/\.(go)$/i.test(lower)) {
    return { text: '🐹', color: '#06b6d4' };
  }
  if (/\.(sh|bash|zsh|ps1|bat|cmd)$/i.test(lower)) {
    return { text: '⚡', color: '#22c55e' };
  }
  if (/\.(log|txt|out)$/i.test(lower)) {
    return { text: '📄', color: '#94a3b8' };
  }
  if (/\.(sqlite|db|sql)$/i.test(lower)) {
    return { text: '🗄', color: '#0ea5e9' };
  }
  if (/\.(zip|tar|gz|7z|rar)$/i.test(lower)) {
    return { text: '📦', color: '#ea580c' };
  }
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx)$/i.test(lower)) {
    return { text: '📑', color: '#ef4444' };
  }

  return { text: '📄', color: '#94a3b8' };
}

function FileIconView({ name }: { name: string }) {
  const icon = getFileIconInfo(name);
  if (icon.isBadge) {
    return (
      <View style={[styles.miniBadge, { borderColor: icon.color }]}>
        <Text style={[styles.miniBadgeText, { color: icon.color }]}>{icon.text}</Text>
      </View>
    );
  }
  return (
    <Text style={[styles.fileIconChar, { color: icon.color || '#94a3b8' }]}>
      {icon.text}
    </Text>
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
          style={({ pressed }) => [
            styles.treeDirRow,
            { paddingLeft: 10 + depth * 14 },
            pressed && { backgroundColor: colors.shell },
          ]}
        >
          <Text style={[styles.treeChevron, { color: colors.muted }]}>
            {expanded ? '⌄' : '›'}
          </Text>
          <Text style={[styles.treeDirName, { color: colors.text }]} numberOfLines={1}>
            {node.name}
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
      style={({ pressed }) => [
        styles.treeFileRow,
        { paddingLeft: 24 + depth * 14 },
        pressed && { backgroundColor: colors.shell },
      ]}
    >
      <FileIconView name={node.name} />
      <Text style={[styles.treeFileName, { color: colors.text }]} numberOfLines={1}>
        {node.name}
      </Text>
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
  head: { fontSize: 17, fontWeight: '700', paddingHorizontal: space.md, paddingTop: 14 },
  cwd: { fontSize: 12, paddingHorizontal: space.md, paddingBottom: 6 },
  searchInput: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6, fontSize: 13 },
  actions: { flexDirection: 'row', gap: 6, paddingHorizontal: space.md, paddingBottom: 6 },
  chip: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  list: { paddingBottom: space.md },
  treeDirRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    paddingRight: 10,
    gap: 4,
    borderRadius: 6,
    marginHorizontal: 4,
  },
  treeChevron: {
    fontSize: 14,
    width: 14,
    textAlign: 'center',
    fontWeight: '600',
  },
  treeDirName: {
    fontSize: 13.5,
    fontWeight: '500',
    flex: 1,
  },
  treeFileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingRight: 10,
    gap: 6,
    borderRadius: 6,
    marginHorizontal: 4,
  },
  treeFileName: {
    fontSize: 13,
    flex: 1,
  },
  miniBadge: {
    width: 16,
    height: 14,
    borderWidth: 1,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniBadgeText: {
    fontSize: 8,
    fontWeight: '800',
    lineHeight: 10,
  },
  fileIconChar: {
    fontSize: 13,
    width: 16,
    textAlign: 'center',
  },
  bars: { paddingHorizontal: space.md, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, gap: 4 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barTrack: { flex: 1, height: 5, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: 5, borderRadius: 3 },
});
