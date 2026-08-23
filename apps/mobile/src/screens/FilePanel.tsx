import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatContextUsage, formatQuotaLine } from '../quota';
import { useHistories, useSession, useTools, useWorkspace } from '../session';
import { radius, space } from '../theme';
import { useTheme } from '../theme-context';
import type { TreeNode } from '../types';

const webNoOutline = Platform.OS === 'web'
  ? ({ outlineWidth: 0, outlineStyle: 'none' as any } as any)
  : null;

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
  onOpenThread,
}: {
  threadId?: string;
  onOpenFile: (path: string) => void;
  onOpenThread?: (id: string) => void;
}) {
  const session = useSession();
  const { histories, openThread } = useHistories();
  const tools = useTools();
  const workspace = useWorkspace();
  const { colors } = useTheme();
  const history = threadId ? histories[threadId] : undefined;
  const cwd = history?.cwd || session.projects[0]?.cwd || '';
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filterQ, setFilterQ] = useState('');
  const [filterFocused, setFilterFocused] = useState(false);
  const [tab, setTab] = useState<'files' | 'git'>('files');
  const [cmd, setCmd] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (threadId) {
      workspace.requestTree(threadId, cwd);
      workspace.listArtifacts(threadId, cwd);
    }
  }, [threadId, cwd]);

  useEffect(() => {
    const q = filterQ.trim();
    if (!threadId || q.length < 2) return;
    const timer = setTimeout(() => workspace.searchWorkspace(threadId, cwd, q), 220);
    return () => clearTimeout(timer);
  }, [filterQ, threadId, cwd]);

  const displayedTree = useMemo(() => filterTree(workspace.tree.tree, filterQ.trim()), [workspace.tree.tree, filterQ]);
  const dirs = useMemo(() => collectDirs(displayedTree), [displayedTree]);

  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const d of dirs) next[d] = true;
    setOpen(next);
  }, [workspace.tree.cwd, dirs, filterQ]);

  const accountLeft = session.quota.primaryUsedPercent != null
    ? Math.max(0, 100 - session.quota.primaryUsedPercent)
    : null;
  const ctxLeft = history?.tokenUsage?.usedPercent != null
    ? Math.max(0, 100 - history.tokenUsage.usedPercent)
    : history?.tokenUsage?.primaryUsedPercent != null
      ? Math.max(0, 100 - history.tokenUsage.primaryUsedPercent)
      : accountLeft;

  async function copyPath(path: string) {
    const next = String(path || '').trim();
    if (!next) return;
    await Clipboard.setStringAsync(next);
    setCopied(next);
    setTimeout(() => setCopied(''), 1600);
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.shell }]}>
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: space.md, paddingTop: 10 }}>
        {(['files', 'git'] as const).map((id) => (
          <Pressable key={id} onPress={() => setTab(id)} hitSlop={6}>
            <Text style={{ color: tab === id ? colors.text : colors.muted, fontSize: 13, fontWeight: tab === id ? '700' : '500' }}>
              {id === 'files' ? '文件' : 'Git / 命令'}
            </Text>
          </Pressable>
        ))}
      </View>
      <Pressable onLongPress={() => { void copyPath(workspace.tree.cwd || cwd); }}>
        <Text style={[styles.cwd, { color: colors.muted }]} numberOfLines={2}>
          {workspace.tree.rootName || cwd || '当前工作目录'}
          {copied && (copied === (workspace.tree.cwd || cwd)) ? '  · 已复制' : ''}
        </Text>
      </Pressable>
      {tab === 'git' ? (
        <View style={{ flex: 1, paddingHorizontal: space.md, gap: 8 }}>
          <Pressable
            onPress={() => { if (threadId) tools.gitStatus(threadId); }}
            style={[styles.chip, { backgroundColor: colors.card, borderColor: colors.line, borderWidth: StyleSheet.hairlineWidth, alignSelf: 'flex-start' }]}
          >
            <Text style={{ color: colors.text, fontSize: 13 }}>刷新 Git</Text>
          </Pressable>
          <ScrollView style={{ flex: 1 }}>
            {tools.git?.error ? (
              <Text selectable style={{ color: '#ef4444', fontSize: 12, lineHeight: 18 }}>{tools.git.error}</Text>
            ) : (tools.git?.files && tools.git.files.length) ? (
              tools.git.files.map((file) => (
                <Pressable
                  key={file.path}
                  onPress={() => onOpenFile(file.path)}
                  style={[styles.chip, { backgroundColor: colors.card, borderColor: colors.line, borderWidth: StyleSheet.hairlineWidth, marginBottom: 6, alignSelf: 'stretch' }]}
                >
                  <Text style={{ color: colors.text, fontSize: 13 }} numberOfLines={1}>{file.path}</Text>
                  <Text style={{ color: colors.muted, fontSize: 11 }}>{file.status || '改动'}  +{file.add || 0}/-{file.del || 0}</Text>
                </Pressable>
              ))
            ) : (
              <Text selectable style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>
                {tools.git?.status || '打开会话后点刷新。'}
              </Text>
            )}
            {tools.git?.log ? (
              <Text selectable style={{ color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 8 }}>
                {tools.git.log.slice(0, 1500)}
              </Text>
            ) : null}
          </ScrollView>
          <View style={{ flexDirection: 'row', gap: 8, paddingBottom: 8 }}>
            <TextInput
              value={cmd}
              onChangeText={setCmd}
              placeholder="$ 在会话目录跑一条命令"
              placeholderTextColor={colors.muted}
              style={[
                styles.searchInput,
                { flex: 1, backgroundColor: colors.bg, color: colors.text, borderColor: colors.line, borderWidth: 1 },
                webNoOutline,
              ]}
              onSubmitEditing={() => {
                const next = cmd.trim().replace(/^\$\s*/, '');
                if (threadId && next) {
                  tools.runCommand(threadId, next);
                  setCmd('');
                }
              }}
            />
            <Pressable
              onPress={() => { if (threadId) tools.stopCommand(threadId); }}
              style={[styles.chip, { backgroundColor: colors.card, borderColor: colors.line, borderWidth: StyleSheet.hairlineWidth }]}
            >
              <Text style={{ color: colors.text, fontSize: 13 }}>停</Text>
            </Pressable>
          </View>
          {tools.commandHist.length ? (
            <ScrollView horizontal style={{ maxHeight: 36 }}>
              {tools.commandHist.map((row) => (
                <Pressable
                  key={row.command}
                  onPress={() => {
                    if (threadId) tools.runCommand(threadId, row.command);
                  }}
                  style={[styles.chip, { marginRight: 6, backgroundColor: colors.card, borderColor: colors.line, borderWidth: StyleSheet.hairlineWidth }]}
                >
                  <Text style={{ color: colors.muted, fontSize: 11 }}>{row.command.slice(0, 24)}</Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
          {tools.commandOut ? (
            <ScrollView style={{ maxHeight: 140, marginBottom: 8 }}>
              <Text selectable style={{ color: colors.muted, fontSize: 11, lineHeight: 16 }}>{tools.commandOut.slice(-4000)}</Text>
            </ScrollView>
          ) : null}
        </View>
      ) : null}
      {tab !== 'files' ? null : (
      <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: space.md, paddingBottom: 8 }}>
        <TextInput
          value={filterQ}
          onChangeText={setFilterQ}
          onFocus={() => setFilterFocused(true)}
          onBlur={() => setFilterFocused(false)}
          placeholder="🔍 搜索整个项目..."
          placeholderTextColor={colors.muted}
          style={[
            styles.searchInput,
            {
              backgroundColor: colors.bg,
              color: colors.text,
              borderColor: filterFocused ? colors.text : colors.line,
              borderWidth: 1,
            },
            webNoOutline,
          ]}
        />
      </View>
      <View style={styles.actions}>
        <Pressable
          style={[styles.chip, { backgroundColor: colors.card, borderColor: colors.line, borderWidth: StyleSheet.hairlineWidth }]}
          onPress={() => {
            const next: Record<string, boolean> = {};
            for (const d of dirs) next[d] = true;
            setOpen(next);
          }}
        >
          <Text style={{ color: colors.text, fontSize: 13 }}>全部展开</Text>
        </Pressable>
        <Pressable
          style={[styles.chip, { backgroundColor: colors.card, borderColor: colors.line, borderWidth: StyleSheet.hairlineWidth }]}
          onPress={() => setOpen({})}
        >
          <Text style={{ color: colors.text, fontSize: 13 }}>全部折叠</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        {filterQ.trim().length >= 2 && workspace.workspaceHits.length ? (
          workspace.workspaceHits.map((hit) => (
            <Pressable
              key={hit.path}
              onPress={() => onOpenFile(hit.path)}
              onLongPress={() => session.queueMention(hit.path)}
              style={[styles.treeFileRow, { paddingLeft: 10 }]}
            >
              <Text style={[styles.treeFileName, { color: colors.text }]} numberOfLines={1}>{hit.name}</Text>
              <Pressable onPress={() => session.queueMention(hit.path)} hitSlop={8}>
                <Text style={{ color: colors.muted, fontSize: 12 }}>@</Text>
              </Pressable>
            </Pressable>
          ))
        ) : null}
        {workspace.artifacts.length ? (
          <View style={{ paddingHorizontal: 4, paddingBottom: 8 }}>
            <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 6 }}>产物</Text>
            {workspace.artifacts.slice(0, 8).map((file) => (
              <Pressable key={file.path} onPress={() => onOpenFile(file.path)} style={{ paddingVertical: 4 }}>
                <Text style={{ color: colors.text, fontSize: 13 }}>{file.name}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {(history?.subagents || []).map((agent) => (
          <Pressable
            key={agent.id}
            onPress={() => {
              openThread(agent.id);
              onOpenThread?.(agent.id);
            }}
            style={{ paddingVertical: 6 }}
          >
            <Text style={{ color: colors.text, fontSize: 13 }}>
              {agent.status === 'working' || agent.status === 'desktop' ? '🟢 ' : '○ '}{agent.title || agent.id.slice(0, 8)}
            </Text>
          </Pressable>
        ))}
        {displayedTree.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            open={open}
            onToggle={(p) => {
              setOpen((prev) => ({ ...prev, [p]: !prev[p] }));
              const find = (nodes: TreeNode[]): TreeNode | null => {
                for (const n of nodes) {
                  if (n.path === p) return n;
                  if (n.children) {
                    const hit = find(n.children);
                    if (hit) return hit;
                  }
                }
                return null;
              };
              const node = find(workspace.tree.tree);
              if (threadId && node?.type === 'directory' && !(node.children && node.children.length) && node.hasChildren !== false) {
                workspace.requestTree(threadId, workspace.tree.cwd || cwd, p);
              }
            }}
            onOpenFile={onOpenFile}
            onMention={(p) => session.queueMention(p)}
            onCopyPath={(p) => { void copyPath(p); }}
          />
        ))}
        {!displayedTree.length ? (
          <Text style={{ color: colors.muted, padding: space.md }}>没有可显示的文件</Text>
        ) : null}
      </ScrollView>
      </View>
      )}
      <View style={[styles.bars, { borderTopColor: colors.line }]}>
        <UsageBar label="账号剩余" value={accountLeft} color={colors.ok} track={colors.card} text={colors.muted} />
        <UsageBar label="上下文剩余" value={ctxLeft} color={colors.warn} track={colors.card} text={colors.muted} />
        {formatQuotaLine(session.quota) ? (
          <Text style={{ color: colors.muted, fontSize: 11 }}>{formatQuotaLine(session.quota)}</Text>
        ) : null}
        {formatContextUsage(history?.tokenUsage) ? (
          <Text style={{ color: colors.muted, fontSize: 11 }}>{formatContextUsage(history?.tokenUsage)}</Text>
        ) : null}
        {(history?.tokenUsage?.sources || []).map((src) => (
          <Text key={src.label} style={{ color: colors.muted, fontSize: 11 }}>
            {src.label} {Math.round(src.percent)}%
          </Text>
        ))}
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
  onMention,
  onCopyPath,
}: {
  node: TreeNode;
  depth: number;
  open: Record<string, boolean>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onMention?: (path: string) => void;
  onCopyPath: (path: string) => void;
}) {
  const { colors } = useTheme();
  if (node.type === 'directory') {
    const expanded = !!open[node.path];
    return (
      <View>
        <Pressable
          onPress={() => onToggle(node.path)}
          onLongPress={() => onCopyPath(node.path)}
          delayLongPress={420}
          style={({ pressed }) => [
            styles.treeDirRow,
            { paddingLeft: 10 + depth * 14 },
            pressed && { backgroundColor: colors.card },
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
                onMention={onMention}
                onCopyPath={onCopyPath}
              />
            ))
          : null}
      </View>
    );
  }
  return (
    <Pressable
      onPress={() => onOpenFile(node.path)}
      onLongPress={() => onCopyPath(node.path)}
      delayLongPress={420}
      style={({ pressed }) => [
        styles.treeFileRow,
        { paddingLeft: 24 + depth * 14 },
        pressed && { backgroundColor: colors.card },
      ]}
    >
      <FileIconView name={node.name} />
      <Text style={[styles.treeFileName, { color: colors.text, flex: 1 }]} numberOfLines={1}>
        {node.name}
      </Text>
      <Pressable onPress={() => onMention?.(node.path)} hitSlop={8}>
        <Text style={{ color: colors.muted, fontSize: 12 }}>@</Text>
      </Pressable>
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
