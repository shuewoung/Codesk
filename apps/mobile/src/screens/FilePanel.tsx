import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { artifactCycle, canShowArtifacts, parentPath, shouldRefreshArtifacts } from '../utils/file-panel';
import { reviewFilePath } from '../utils/thread-ui';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatContextUsage, formatQuotaLine } from '../quota';
import { useHistories, useSession, useTools, useWorkspace } from '../session';
import { radius, space } from '../theme';
import { useTheme } from '../theme-context';
import type { TreeNode } from '../types';
import { triggerHaptic } from '../utils/haptics';
import { TerminalView } from './TerminalView';
import { UnifiedDiffView } from '../components/UnifiedDiffView';
import { FileIcon, formatFileSize } from '../components/FileIcon';
export { getFileIconInfo } from '../components/FileIcon';
export type FileEntry = { path: string; name: string; isDir: boolean; size?: number; mtimeMs?: number };

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
  onSelectFiles,
  onClose,
}: {
  threadId?: string;
  onOpenFile: (path: string) => void;
  onOpenThread?: (id: string) => void;
  onSelectFiles?: (files: FileEntry[]) => void;
  onClose?: () => void;
}) {
  const session = useSession();
  const { histories, openThread } = useHistories();
  const tools = useTools();
  const workspace = useWorkspace();
  const { colors } = useTheme();
  const { requestTree, listArtifacts, searchWorkspace } = workspace;
  const { gitStatus, gitDiff } = tools;
  const git = tools.git?.threadId === threadId ? tools.git : null;
  const [gitFile, setGitFile] = useState('');
  const selectedGitFile = git?.files?.find(file => file.path === gitFile);
  useEffect(() => setGitFile(''), [threadId]);
  const history = threadId ? histories[threadId] : undefined;
  const cwd = history?.cwd || session.threads.find(t => t.id === threadId)?.cwd || '';
  const [selected, setSelected] = useState<Record<string, FileEntry>>({});
  const [located, setLocated] = useState('');
  useEffect(() => { setSelected({}); setLocated(''); }, [threadId, cwd]);
  const toggleFile = (file: FileEntry) => setSelected(prev => { const next = { ...prev }; if (next[file.path]) delete next[file.path]; else next[file.path] = file; return next; });
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filterQ, setFilterQ] = useState('');
  const [filterFocused, setFilterFocused] = useState(false);
  const [tab, setTab] = useState<'artifacts' | 'files' | 'git' | 'term'>(onSelectFiles ? 'files' : 'artifacts');
  const panelRequest = session.requestState(tab === 'artifacts' ? 'list_artifacts' : 'get_workspace_tree', threadId, tab === 'artifacts' ? undefined : cwd);
  const artifactRequest = session.requestState('list_artifacts', threadId);
  const cycle = artifactCycle(history, session.threads.find(t => t.id === threadId)?.status);
  const cycleKey = JSON.stringify([threadId, cwd, cycle.key]);
  const processedCycle = useRef<string | undefined>(undefined);
  const currentRequestId = useRef(artifactRequest?.requestId);
  currentRequestId.current = artifactRequest?.requestId;
  const [artifactRefresh, setArtifactRefresh] = useState<{ key: string; staleRequestId?: string }>();
  const artifactsVisible = canShowArtifacts(artifactRefresh?.key, cycleKey, cycle.active, artifactRequest, artifactRefresh?.staleRequestId);
  const [artifactFilter, setArtifactFilter] = useState<'all' | 'images' | 'documents'>('all');
  const artifacts = artifactsVisible ? workspace.artifacts.filter(file => (!file.threadId || file.threadId === threadId) && (artifactFilter === 'all' || (artifactFilter === 'images' ? /\.(png|jpe?g|webp|gif)$/i.test(file.path) : !/\.(png|jpe?g|webp|gif)$/i.test(file.path)))).sort((a, b) => String(a.turnId || '').localeCompare(String(b.turnId || ''))) : [];
  const artifactLabel = artifactsVisible && workspace.artifactsScope === 'session_confirmed' ? '会话已确认文件' : '本次产物';
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (threadId) requestTree(threadId, cwd);
  }, [threadId, cwd, requestTree]);

  useEffect(() => {
    const refresh = shouldRefreshArtifacts(processedCycle.current, cycleKey, cycle.active);
    processedCycle.current = cycleKey;
    if (cycle.active) setArtifactRefresh(undefined);
    if (threadId && refresh) {
      setArtifactRefresh({ key: cycleKey, staleRequestId: currentRequestId.current });
      listArtifacts(threadId, cwd);
    }
  }, [threadId, cwd, cycleKey, cycle.active, listArtifacts]);

  useEffect(() => {
    const q = filterQ.trim();
    if (!threadId || q.length < 2) return;
    const timer = setTimeout(() => searchWorkspace(threadId, cwd, q), 220);
    return () => clearTimeout(timer);
  }, [filterQ, threadId, cwd, searchWorkspace]);

  const displayedTree = useMemo(() => filterTree(workspace.tree.tree, filterQ.trim()), [workspace.tree.tree, filterQ]);
  const dirs = useMemo(() => collectDirs(displayedTree), [displayedTree]);

  useEffect(() => {
    setOpen({});
  }, [workspace.tree.cwd]);

  useEffect(() => {
    if (!filterQ.trim()) return;
    const next: Record<string, boolean> = {};
    for (const d of dirs) next[d] = true;
    setOpen(next);
  }, [filterQ, dirs]);

  useEffect(() => {
    if (tab === 'git' && threadId) { gitStatus(threadId); gitDiff(threadId); }
  }, [tab, threadId, gitStatus, gitDiff]);

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
        {([
          ['artifacts', artifactLabel],
          ['files', '项目文件'],
          ['git', 'Git'],
          ['term', '终端'],
        ] as const).filter(([id]) => !onSelectFiles || id === 'files' || id === 'artifacts').map(([id, label]) => (
          <Pressable key={id} onPress={() => setTab(id)} hitSlop={6}>
            <Text style={{ color: tab === id ? colors.text : colors.muted, fontSize: 13, fontWeight: tab === id ? '700' : '500' }}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
      {onClose ? <Pressable onPress={onClose} style={{ padding: 10 }}><Text style={{ color: colors.text }}>关闭文件选择</Text></Pressable> : null}
      <Pressable onLongPress={() => { void copyPath(workspace.tree.cwd || cwd); }}>
        <Text style={[styles.cwd, { color: colors.muted }]} numberOfLines={2}>
          {workspace.tree.rootName || cwd || '当前工作目录'}
          {copied && (copied === (workspace.tree.cwd || cwd)) ? '  · 已复制' : ''}
        </Text>
      </Pressable>
      {tab === 'git' ? (
        <View style={{ flex: 1, paddingHorizontal: space.md, gap: 8 }}>
          <Text style={{ color: colors.muted, fontSize: 12 }}>只读变更审阅 · 不暂存、不提交、不回滚。此处展示当前工作区快照，不等同于本轮产物。</Text>
          <Text style={{ color: colors.muted, fontSize: 12 }}>分支：{git?.branch || '未提供'}</Text>
          {(['get_git_status', 'get_git_diff'] as const).map(type => session.requestState(type, threadId)?.error ? <Text key={type} style={{ color: colors.danger }}>{session.requestState(type, threadId)?.error}</Text> : null)}
          <Pressable
            onPress={() => { if (threadId) { gitStatus(threadId); gitDiff(threadId); } }}
            style={[styles.chip, { backgroundColor: colors.card, borderColor: colors.line, borderWidth: StyleSheet.hairlineWidth, alignSelf: 'flex-start' }]}
          >
            <Text style={{ color: colors.text, fontSize: 13 }}>刷新 Git</Text>
          </Pressable>
          <ScrollView style={{ flex: 1 }}>
            {git?.error ? (
              <Text selectable style={{ color: '#ef4444', fontSize: 12, lineHeight: 18 }}>
                {/not a git repository/i.test(git.error) ? '这个目录不是 git 仓库' : git.error}
              </Text>
            ) : (git?.files && git.files.length) ? (
              git.files.map((file) => (
                <Pressable
                  key={file.path}
                  onPress={() => setGitFile(file.path)}
                  style={[styles.chip, { backgroundColor: colors.card, borderColor: colors.line, borderWidth: StyleSheet.hairlineWidth, marginBottom: 6, alignSelf: 'stretch' }]}
                >
                  <Text style={{ color: colors.text, fontSize: 13 }} numberOfLines={1}>{file.path}</Text>
                  <Text style={{ color: colors.muted, fontSize: 11 }}>{file.status || '改动'}  +{file.add || 0}/-{file.del || 0}</Text>
                </Pressable>
              ))
            ) : (
              <Text selectable style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>
                {git?.status || (threadId ? '正在读取 Git…' : '打开一个会话后再看 Git。')}
              </Text>
            )}
            {selectedGitFile ? <View style={{ gap: 8 }}>
              <Text selectable style={{ color: colors.text }}>{selectedGitFile.path}</Text>
              {selectedGitFile.patch ? <UnifiedDiffView patch={selectedGitFile.patch} /> : <Text style={{ color: colors.muted }}>{selectedGitFile.binary ? '二进制文件，无文本差异' : '没有可用文本差异（未跟踪文件或仅元数据变更）'}</Text>}
              {!/D/.test(selectedGitFile.status || '') ? <Pressable onPress={() => onOpenFile(reviewFilePath(cwd, selectedGitFile.path))}><Text style={{ color: colors.text }}>打开文件</Text></Pressable> : null}
            </View> : null}
            {!selectedGitFile && git?.diff ? <View style={{ gap: 8, marginTop: 8 }}>
              <Text style={{ color: colors.muted, fontSize: 12 }}>工作区差异{git.truncated ? '（已截断）' : ''}</Text>
              <UnifiedDiffView patch={git.diff} />
            </View> : null}
            <Text style={{ color: colors.muted, marginTop: 12 }}>最近提交</Text>
            {git?.commits?.length ? git.commits.map(commit => <View key={commit.hash} style={{ paddingVertical: 8 }}>
              <Text selectable style={{ color: colors.text }}>{commit.subject}</Text>
              <Text selectable style={{ color: colors.muted, fontSize: 11 }}>{commit.hash.slice(0, 8)} · {commit.author} · {commit.date}{commit.refs ? ` · ${commit.refs}` : ''}</Text>
            </View>) : <Text style={{ color: colors.muted }}>暂无提交记录</Text>}
          </ScrollView>
        </View>
      ) : null}
      {tab === 'term' ? (
        threadId ? (
          <TerminalView
            threadId={threadId}
            chunk={tools.ptyChunk}
            alive={Boolean(tools.ptyAlive[threadId])}
            error={tools.ptyError}
            openPty={tools.openPty}
            writePty={tools.writePty}
            resizePty={tools.resizePty}
          />
        ) : (
          <Text style={{ color: colors.muted, fontSize: 12, paddingHorizontal: space.md }}>打开一个会话后再用终端。</Text>
        )
      ) : null}
      {(tab === 'artifacts' || tab === 'files') ? <View style={{ paddingHorizontal: space.md, paddingVertical: 6, gap: 6 }}>
        {panelRequest?.status === 'loading' ? <Text style={{ color: colors.muted }}>正在加载…</Text> : null}
        {panelRequest?.status === 'error' || panelRequest?.status === 'timeout' ? <Text style={{ color: colors.danger }}>{panelRequest.error || '加载失败，请重试'}</Text> : null}
        <Pressable onPress={() => { if (threadId) { workspace.requestTree(threadId, cwd); workspace.listArtifacts(threadId, cwd); } }}><Text style={{ color: colors.text }}>刷新文件</Text></Pressable>
      </View> : null}
      {tab === 'artifacts' ? <ScrollView contentContainerStyle={styles.list}>
        <View style={{ flexDirection: 'row', gap: 16, padding: 12 }}>{(['all', 'images', 'documents'] as const).map(filter => <Pressable key={filter} onPress={() => setArtifactFilter(filter)}><Text style={{ color: artifactFilter === filter ? colors.text : colors.muted }}>{filter === 'all' ? '全部产物' : filter === 'images' ? '图片' : '其他文件'}</Text></Pressable>)}</View>
        <Text style={{ color: colors.muted, padding: space.md }}>{cycle.active ? '本轮运行中，已隐藏上一轮产物；完成后自动刷新。' : artifactsVisible && workspace.artifactsScope === 'session_confirmed' ? '未能确定最新轮次边界，下列为会话已确认文件，不代表本次生成。' : '仅展示最新轮次真实产物记录；项目近期文档不计为产物。'}</Text>
        {artifactsVisible && workspace.artifactsCoverage?.truncated ? <Text style={{ color: colors.warn, paddingHorizontal: space.md }}>索引范围有限：仅读取 {formatFileSize(workspace.artifactsCoverage.bytesRead)} / {formatFileSize(workspace.artifactsCoverage.totalBytes)}，可能遗漏文件。</Text> : null}
        {artifactsVisible && workspace.artifactsTurnId ? <Text style={{ color: colors.muted, paddingHorizontal: space.md, fontSize: 11 }}>轮次：{workspace.artifactsTurnId}</Text> : null}
        {!artifacts.length ? <Text style={{ color: colors.muted, padding: space.md }}>{artifactRequest?.status === 'loading' ? '正在读取产物记录…' : '暂无已确认产物'}</Text> : artifacts.map((file, index) => (
          <View key={file.path} style={{ padding: 10, gap: 6 }}>
            {index === 0 || file.turnId !== artifacts[index - 1].turnId ? <Text style={{ color: colors.muted }}>轮次：{file.turnId || '会话已确认（轮次未知）'}</Text> : null}
            <Pressable onPress={() => onSelectFiles ? toggleFile({ ...file, isDir: false }) : onOpenFile(file.path)} style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <FileIcon name={file.name} />
              <Text style={{ flex: 1, color: colors.text }}>{onSelectFiles ? (selected[file.path] ? '[已选] ' : '[选择] ') : ''}{file.name}</Text>
            </Pressable>
            <Text selectable style={{ color: colors.muted, fontSize: 11 }}>{file.path}</Text>
            <Text style={{ color: colors.muted, fontSize: 11 }}>{formatFileSize(file.size)}{file.mtimeMs ? ` · ${new Date(file.mtimeMs).toLocaleString()}` : ''}{file.turnId ? ` · 轮次 ${file.turnId}` : ''}{file.timestamp ? ` · ${file.timestamp}` : ''}</Text>
            <View style={{ flexDirection: 'row', gap: 16 }}>
              <Pressable onPress={() => onOpenFile(file.path)}><Text style={{ color: colors.text }}>预览</Text></Pressable>
              <Pressable onPress={() => { setTab('files'); setLocated(file.path); setFilterQ(file.name); if (threadId) workspace.requestTree(threadId, cwd, parentPath(file.path)); }}><Text style={{ color: colors.text }}>在项目中定位</Text></Pressable>
            </View>
          </View>
        ))}
      </ScrollView> : null}
      {tab !== 'files' ? null : (
      <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: space.md, paddingBottom: 8 }}>
        <TextInput
          value={filterQ}
          onChangeText={setFilterQ}
          onFocus={() => setFilterFocused(true)}
          onBlur={() => setFilterFocused(false)}
          placeholder="搜索项目文件..."
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
          hitSlop={6}
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
          hitSlop={6}
          onPress={() => setOpen({})}
        >
          <Text style={{ color: colors.text, fontSize: 13 }}>全部折叠</Text>
        </Pressable>
      </View>
      {located ? <Text selectable style={{ color: colors.muted, paddingHorizontal: space.md }}>定位：{located}</Text> : null}
      <ScrollView contentContainerStyle={styles.list}>
        {filterQ.trim().length >= 2 && workspace.workspaceHits.length ? (
          workspace.workspaceHits.map((hit) => (
            <Pressable
              key={hit.path}
              onPress={() => onSelectFiles ? toggleFile({ ...hit, isDir: false }) : onOpenFile(hit.path)}
              onLongPress={() => session.queueMention(hit.path)}
              style={[styles.treeFileRow, { paddingLeft: 10 }]}
            >
              <FileIcon name={hit.name} /><Text style={[styles.treeFileName, { color: colors.text }]} numberOfLines={1}>{onSelectFiles ? (selected[hit.path] ? "[已选] " : "[选择] ") : ""}{hit.name}</Text>
              <Pressable onPress={() => onOpenFile(hit.path)}><Text style={{ color: colors.muted }}>预览</Text></Pressable>
              <Pressable onPress={() => session.queueMention(hit.path)} hitSlop={8}>
                <Text style={{ color: colors.muted, fontSize: 12 }}>@</Text>
              </Pressable>
            </Pressable>
          ))
        ) : null}
        {!filterQ.trim() && workspace.recentDocuments.length ? <View style={{ padding: 10, gap: 6 }}>
          <Text style={{ color: colors.muted, fontSize: 12 }}>近期文档（项目扫描，非本次产物）</Text>
          {workspace.recentDocuments.slice(0, 8).map(file => <View key={file.path} style={{ gap: 4 }}>
            <Pressable onPress={() => onSelectFiles ? toggleFile({ ...file, isDir: false }) : onOpenFile(file.path)} style={{ flexDirection: 'row', gap: 8 }}><FileIcon name={file.name} /><Text style={{ color: colors.text, flex: 1 }}>{selected[file.path] ? '[已选] ' : ''}{file.name}</Text></Pressable>
            <Text selectable style={{ color: colors.muted, fontSize: 11 }}>{file.path} · {formatFileSize(file.size)}</Text>
            {onSelectFiles ? <Pressable onPress={() => onOpenFile(file.path)}><Text style={{ color: colors.muted }}>预览</Text></Pressable> : null}
          </View>)}
        </View> : null}
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
              {agent.title || agent.id.slice(0, 8)} · {agent.status || 'unknown'}{agent.model ? ` · ${agent.model}` : ''}
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
            selected={onSelectFiles ? selected : undefined}
            onSelect={onSelectFiles ? toggleFile : undefined}
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
      {onSelectFiles ? <View style={{ padding: space.md, gap: 8, borderTopWidth: 1, borderColor: colors.line }}>
        <Text style={{ color: colors.muted }}>宿主机项目文件 · 已选 {Object.keys(selected).length} 项</Text>
        <Text style={{ color: colors.muted, fontSize: 11 }}>默认会话工作目录；文件访问仍遵循宿主机目录权限。</Text>
        <View style={{ flexDirection: 'row', gap: 20 }}>
          <Pressable disabled={!Object.keys(selected).length} onPress={() => onSelectFiles(Object.values(selected))}><Text style={{ color: Object.keys(selected).length ? colors.text : colors.muted, fontWeight: '700' }}>确认选择</Text></Pressable>
          <Pressable onPress={() => setSelected({})}><Text style={{ color: colors.muted }}>清空选择</Text></Pressable>
        </View>
      </View> : null}
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

function TreeRow({
  node,
  depth,
  open,
  onToggle,
  onOpenFile,
  onMention,
  onCopyPath,
  selected,
  onSelect,
}: {
  selected?: Record<string, FileEntry>;
  onSelect?: (file: FileEntry) => void;
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
          onPress={() => {
            triggerHaptic('light');
            onToggle(node.path);
          }}
          onLongPress={() => {
            triggerHaptic('medium');
            onCopyPath(node.path);
          }}
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
                selected={selected}
                onSelect={onSelect}
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
      onPress={() => {
        triggerHaptic('light');
        if (onSelect) onSelect({ path: node.path, name: node.name, isDir: false }); else onOpenFile(node.path);
      }}
      onLongPress={() => {
        triggerHaptic('medium');
        onCopyPath(node.path);
      }}
      delayLongPress={420}
      style={({ pressed }) => [
        styles.treeFileRow,
        { paddingLeft: 24 + depth * 14 },
        pressed && { backgroundColor: colors.card },
      ]}
    >
      <FileIcon name={node.name} />
      <Text style={[styles.treeFileName, { color: colors.text, flex: 1 }]} numberOfLines={1}>
        {selected ? (selected[node.path] ? "[已选] " : "[选择] ") : ""}{node.name}
      </Text>
      {onSelect ? <Pressable onPress={() => onOpenFile(node.path)}><Text style={{ color: colors.muted }}>预览</Text></Pressable> : null}
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
