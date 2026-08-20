import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { ApprovalBar } from '../components/ApprovalBar';
import { EmptyState, ErrorBanner } from '../components/ui';
import { approvalFromHistory, flattenItems } from '../history';
import { useSession } from '../session';
import { radius, space } from '../theme';
import { useTheme } from '../theme-context';
import type { TimelineNode } from '../types';

export function ThreadScreen({
  threadId,
  onOpenLeft,
  onOpenRight,
  onOpenFile,
  onScan,
}: {
  threadId?: string;
  onOpenLeft: () => void;
  onOpenRight: () => void;
  onOpenFile: (path: string) => void;
  onScan: () => void;
}) {
  const session = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState('');
  const [kb, setKb] = useState(0);
  const [plus, setPlus] = useState(false);
  const [sheet, setSheet] = useState<'none' | 'status' | 'more' | 'rename' | 'model' | 'effort' | 'access' | 'search'>('none');
  const [searchQ, setSearchQ] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [pending, setPending] = useState<{ name: string; path: string; image: boolean }[]>([]);
  const listRef = useRef<FlatList<TimelineNode>>(null);
  const thread = session.threads.find((t) => t.id === threadId);
  const history = threadId ? session.histories[threadId] : undefined;
  const approval = threadId ? session.approvals[threadId] || approvalFromHistory(threadId, history) : null;
  const nodes = useMemo(
    () => flattenItems(history?.items || []).filter((n) => n.kind === 'user' || n.kind === 'assistant' || n.kind === 'diff' || n.kind === 'command' || n.kind === 'system'),
    [history?.items],
  );
  const working = history?.status === 'working';
  const project = session.projects.find((p) => p.threads.some((t) => t.id === threadId));

  useEffect(() => {
    if (threadId) session.openThread(threadId);
  }, [threadId]);

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      setKb(0);
      return;
    }
    const show = Keyboard.addListener('keyboardWillShow', (e) => {
      setKb(Math.max(0, e.endCoordinates.height - insets.bottom));
    });
    const hide = Keyboard.addListener('keyboardWillHide', () => {
      setKb(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [insets.bottom]);

  useEffect(() => {
    if (!nodes.length) return;
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
  }, [nodes.length, history?.status]);

  useEffect(() => {
    const up = session.lastUpload;
    if (!up || up.error || !up.path) return;
    setPending((prev) => [...prev, { name: up.name, path: up.path, image: /\.(png|jpe?g|gif|webp)$/i.test(up.name) }]);
    session.clearUpload();
  }, [session.lastUpload]);

  async function pickPhoto(fromCamera: boolean) {
    if (!threadId) return;
    const perm = fromCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      session.clearError();
      return;
    }
    const res = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, base64: true });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    const name = asset.fileName || `photo-${Date.now()}.jpg`;
    let b64 = asset.base64 || '';
    if (!b64 && asset.uri) b64 = await new File(asset.uri).base64();
    if (!b64) return;
    session.uploadFile(threadId, name, b64, asset.mimeType || 'image/jpeg');
    setPlus(false);
  }

  async function pickFile() {
    if (!threadId) return;
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    const b64 = await new File(asset.uri).base64();
    session.uploadFile(threadId, asset.name || 'file', b64, asset.mimeType || '');
    setPlus(false);
  }

  function send() {
    if (!threadId) {
      session.createThread(session.projects[0]?.cwd);
      return;
    }
    const text = draft.trim();
    if (!text && !pending.length) return;
    const input = [
      ...pending.map((p) => (p.image ? { type: 'localImage', path: p.path } : { type: 'mention', name: p.name, path: p.path })),
      ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
    ];
    if (text.startsWith('$ ')) {
      session.runCommand(threadId, text.slice(2));
      setDraft('');
      return;
    }
    if (/^\/(review|compact|init|status|plan)\b/.test(text)) {
      session.sendComposer(threadId, text, false);
      setDraft('');
      return;
    }
    session.sendComposer(threadId, text, working, input);
    setDraft('');
    setPending([]);
  }

  const ctxUsed = history?.tokenUsage?.usedPercent
    ?? session.quota.usedPercent
    ?? 0;
  const accountUsed = session.quota.primaryUsedPercent;
  const windowLeft = accountUsed == null ? null : Math.max(0, Math.min(100, 100 - accountUsed));
  const hostLabel = session.hostName || '';
  const modelLabel = session.config.rawModel || session.config.model || '模型';
  const effortLabel = session.config.effort || '推理';
  const accessLabel = session.config.accessMode === 'ask' ? '请求批准' : session.config.accessMode === 'auto' ? '帮我批准' : '完全访问';
  const resetText = session.quota.resetAtMs
    ? new Date(session.quota.resetAtMs).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '未知';

  const mdStyle = {
    body: { color: colors.text, fontSize: 16, lineHeight: 24 },
    heading1: { color: colors.text, fontSize: 22, fontWeight: '700' as const },
    heading2: { color: colors.text, fontSize: 19, fontWeight: '700' as const },
    code_inline: { backgroundColor: colors.card, color: colors.text, borderRadius: 4, paddingHorizontal: 4 },
    fence: { backgroundColor: colors.shell, color: colors.text, borderRadius: 8, padding: 8 },
    link: { color: colors.ok },
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.bg, paddingBottom: kb > 0 ? kb : insets.bottom + 8 }]}>
      <View style={styles.header}>
        <Pressable onPress={onOpenLeft} style={[styles.round, { backgroundColor: colors.shell }]} hitSlop={6}>
          <Text style={{ color: colors.text, fontSize: 18 }}>☰</Text>
        </Pressable>
        <Pressable onPress={() => setSheet('status')} style={[styles.round, { backgroundColor: colors.shell }]} hitSlop={6}>
          <QuotaRing remaining={windowLeft} />
        </Pressable>
        <View style={[styles.titlePill, { backgroundColor: colors.shell }]}>
          <Text style={{ color: colors.text, fontWeight: '600' }} numberOfLines={1}>
            {thread?.title || '新聊天'}
          </Text>
          <View style={styles.metaRow}>
            <Text style={{ color: colors.muted, fontSize: 11 }} numberOfLines={1}>
              {project?.name || '未分组'}
            </Text>
            <View style={[styles.liveDot, { backgroundColor: session.conn === 'connected' ? '#22c55e' : '#ef4444' }]} />
            {hostLabel ? (
              <Text style={{ color: colors.muted, fontSize: 11 }} numberOfLines={1}>
                {hostLabel}
              </Text>
            ) : null}
          </View>
        </View>
        <Pressable onPress={onOpenRight} style={[styles.round, { backgroundColor: colors.shell }]} hitSlop={6}>
          <Text style={{ color: colors.text, fontSize: 16 }}>📁</Text>
        </Pressable>
        <Pressable onPress={() => setSheet((s) => (s === 'more' ? 'none' : 'more'))} style={[styles.round, { backgroundColor: colors.shell }]} hitSlop={6}>
          <Text style={{ color: colors.text, fontSize: 18 }}>⋯</Text>
        </Pressable>
      </View>

      {/* Model & Permission Micro Bar */}
      <View style={styles.configBar}>
        <Pressable
          style={[styles.configPill, { backgroundColor: colors.shell }]}
          onPress={() => setSheet(sheet === 'model' ? 'none' : 'model')}
        >
          <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600' }} numberOfLines={1}>
            ⚡ {modelLabel} · {effortLabel}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.configPill, { backgroundColor: colors.shell }]}
          onPress={() => setSheet(sheet === 'access' ? 'none' : 'access')}
        >
          <Text style={{ color: colors.muted, fontSize: 12 }} numberOfLines={1}>
            🛡️ {accessLabel}
          </Text>
        </Pressable>
      </View>

      <ErrorBanner text={session.error || session.feedback} onClose={() => { session.clearError(); session.clearFeedback(); }} />
      {!session.paired ? (
        <Pressable
          onPress={onScan}
          style={{ marginHorizontal: 16, marginBottom: 8, backgroundColor: colors.text, borderRadius: 12, paddingVertical: 12, alignItems: 'center' }}
        >
          <Text style={{ color: colors.bg, fontWeight: '700' }}>
            {Platform.OS === 'web' ? '未连接，点此重新配对' : '未连接，点此扫码'}
          </Text>
        </Pressable>
      ) : session.conn !== 'connected' ? (
        <Text style={{ marginHorizontal: 16, marginBottom: 8, color: colors.muted, fontSize: 13 }}>
          {session.connText}
        </Text>
      ) : null}

      <FlatList
        ref={listRef}
        data={nodes}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.feed}
        ListEmptyComponent={<EmptyState title={threadId ? '开始处理' : '选择或新建会话'} />}
        ListHeaderComponent={
          threadId && history?.hasMore ? (
            <Pressable
              onPress={() => session.loadOlderHistory(threadId)}
              style={{ paddingVertical: 12, alignItems: 'center' }}
            >
              <Text style={{ color: colors.muted, fontSize: 13 }}>加载更早的消息</Text>
            </Pressable>
          ) : null
        }
        onScroll={(e) => {
          if (!threadId || !history?.hasMore) return;
          if (e.nativeEvent.contentOffset.y < 40) session.loadOlderHistory(threadId);
        }}
        scrollEventThrottle={200}
        renderItem={({ item }) => <NodeView node={item} mdStyle={mdStyle} onOpenFile={onOpenFile} />}
      />

      {approval && threadId ? (
        <View style={styles.pad}>
          <ApprovalBar approval={approval} onDecide={(d) => session.sendApproval(threadId, d)} />
        </View>
      ) : null}

      {/* Floating Active Action / Working Capsule */}
      {working ? (
        <View style={styles.floatingCapsuleWrap}>
          <View style={[styles.capsuleInner, { backgroundColor: colors.shell, borderColor: colors.line }]}>
            <ActivityIndicator size="small" color={colors.text} style={{ transform: [{ scale: 0.75 }] }} />
            <Text style={[styles.capsuleText, { color: colors.text }]} numberOfLines={1}>
              {history?.activeActionText ? `正在执行: ${history.activeActionText}` : 'Codex 正在运行…'}
            </Text>
          </View>
        </View>
      ) : null}

      {sheet === 'status' ? (
        <Pressable style={styles.mask} onPress={() => setSheet('none')}>
          <View style={[styles.card, { backgroundColor: colors.bg }]}>
            <Text style={[styles.cardK, { color: colors.muted }]}>状态</Text>
            <Text style={[styles.cardV, { color: colors.text }]}>
              {session.connText}
            </Text>
            <Text style={[styles.cardK, { color: colors.muted }]}>对话线程</Text>
            <Text selectable style={[styles.cardV, { color: colors.text }]}>{threadId || '—'}</Text>
            <Text style={[styles.cardK, { color: colors.muted }]}>目录</Text>
            <Text style={[styles.cardV, { color: colors.text }]}>{history?.cwd || project?.cwd || '—'}</Text>
            <Text style={[styles.cardK, { color: colors.muted }]}>上下文</Text>
            <Text style={[styles.cardV, { color: colors.text }]}>
              {history?.tokenUsage?.totalTokens && history?.tokenUsage?.maxContext
                ? `已用 ${Math.round(history.tokenUsage.totalTokens / 1000)}K / ${Math.round(history.tokenUsage.maxContext / 1000)}K（占用 ${ctxUsed}%）`
                : ctxUsed ? `占用 ${ctxUsed}%` : '暂无'}
            </Text>
            <Text style={[styles.cardK, { color: colors.muted }]}>用量窗口</Text>
            <Text style={[styles.cardV, { color: colors.text }]}>
              {windowLeft != null ? `剩余 ${Math.round(windowLeft)}% · 重置 ${resetText}` : '暂无'}
            </Text>
          </View>
        </Pressable>
      ) : null}

      {sheet === 'more' && threadId ? (
        <Pressable style={styles.mask} onPress={() => setSheet('none')}>
          <View style={[styles.card, { backgroundColor: colors.bg }]}>
            <Pressable style={styles.menuItem} onPress={() => setSheet('search')}>
              <Text style={{ color: colors.text, fontSize: 16 }}>🔍 会话内搜索</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={() => { session.togglePin(threadId); setSheet('none'); }}>
              <Text style={{ color: colors.text, fontSize: 16 }}>{session.pinnedIds.includes(threadId) ? '📌 取消置顶' : '📌 置顶'}</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={() => { void Clipboard.setStringAsync(threadId); setSheet('none'); }}>
              <Text style={{ color: colors.text, fontSize: 16 }}>📋 复制会话 ID</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={() => { setRenameDraft(thread?.title || ''); setSheet('rename'); }}>
              <Text style={{ color: colors.text, fontSize: 16 }}>✏️ 重命名</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={() => { session.archiveThread(threadId); setSheet('none'); }}>
              <Text style={{ color: colors.danger, fontSize: 16 }}>📦 归档</Text>
            </Pressable>
          </View>
        </Pressable>
      ) : null}

      {sheet === 'search' && threadId ? (
        <Pressable style={styles.mask} onPress={() => setSheet('none')}>
          <View style={[styles.card, { backgroundColor: colors.bg }]}>
            <Text style={{ color: colors.text, fontWeight: '600', marginBottom: 8 }}>会话内搜索</Text>
            <TextInput
              value={searchQ}
              onChangeText={setSearchQ}
              placeholder="关键词"
              placeholderTextColor={colors.muted}
              style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 10, color: colors.text }}
              onSubmitEditing={() => session.searchThread(threadId, searchQ)}
            />
            <Pressable style={{ marginTop: 10, alignSelf: 'flex-end' }} onPress={() => session.searchThread(threadId, searchQ)}>
              <Text style={{ color: colors.text, fontWeight: '700' }}>搜索</Text>
            </Pressable>
            {session.searchHits.map((hit, i) => (
              <Text key={`${hit.index}-${i}`} selectable style={{ color: colors.muted, fontSize: 12, marginTop: 8 }}>
                {hit.snippet}
              </Text>
            ))}
          </View>
        </Pressable>
      ) : null}

      {sheet === 'rename' && threadId ? (
        <Pressable style={styles.mask} onPress={() => setSheet('none')}>
          <View style={[styles.card, { backgroundColor: colors.bg }]}>
            <Text style={{ color: colors.text, fontWeight: '600', marginBottom: 8 }}>重命名</Text>
            <TextInput
              value={renameDraft}
              onChangeText={setRenameDraft}
              style={{ borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 10, color: colors.text }}
            />
            <Pressable
              style={{ marginTop: 12, alignSelf: 'flex-end' }}
              onPress={() => { session.renameThread(threadId, renameDraft); setSheet('none'); }}
            >
              <Text style={{ color: colors.text, fontWeight: '700' }}>保存</Text>
            </Pressable>
          </View>
        </Pressable>
      ) : null}

      {sheet === 'model' ? (
        <View style={[styles.plusMenu, { backgroundColor: colors.bg, borderColor: colors.line }]}>
          <Text style={{ color: colors.muted, fontSize: 12, paddingHorizontal: 16, paddingTop: 10 }}>选择模型</Text>
          {session.models.map((m) => (
            <Pressable
              key={m.id}
              style={styles.plusItem}
              onPress={() => {
                session.updateConfig('model', m.id);
                const ids = (m.supportedReasoningEfforts || []).map((e) => e.id).filter(Boolean);
                const cur = session.config.effort || '';
                if (ids.length && !ids.includes(cur)) {
                  session.updateConfig('effort', m.defaultReasoningEffort || ids[0]);
                }
                setSheet('none');
              }}
            >
              <Text style={{ color: colors.text, fontWeight: session.config.model === m.id ? '700' : '400' }}>
                {m.displayName || m.id} {session.config.model === m.id ? '✓' : ''}
              </Text>
            </Pressable>
          ))}
          <Text style={{ color: colors.muted, fontSize: 12, paddingHorizontal: 16, paddingTop: 6 }}>推理强度</Text>
          <View style={{ flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 8, gap: 8, flexWrap: 'wrap' }}>
            {(session.models.find((m) => m.id === session.config.model)?.supportedReasoningEfforts || [])
              .map((e) => e.id)
              .filter(Boolean)
              .concat(
                session.models.find((m) => m.id === session.config.model)?.supportedReasoningEfforts?.length
                  ? []
                  : ['low', 'medium', 'high', 'xhigh'],
              )
              .map((lvl) => (
              <Pressable
                key={lvl}
                style={[styles.miniChip, { backgroundColor: session.config.effort === lvl ? colors.card : colors.shell, borderColor: colors.line }]}
                onPress={() => { session.updateConfig('effort', lvl); setSheet('none'); }}
              >
                <Text style={{ color: colors.text, fontSize: 12, fontWeight: session.config.effort === lvl ? '700' : '400' }}>{lvl}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {sheet === 'access' ? (
        <View style={[styles.plusMenu, { backgroundColor: colors.bg, borderColor: colors.line }]}>
          <Text style={{ color: colors.muted, fontSize: 12, paddingHorizontal: 16, paddingTop: 10 }}>权限模式</Text>
          {[
            ['ask', '✋ 请求批准', '外部操作和网络需逐一批准'],
            ['auto', '🛡️ 帮我批准', '仅对风险操作请求批准'],
            ['full', '⚡ 完全访问', '不受限制地操作与访问'],
          ].map(([id, title, desc]) => (
            <Pressable key={id} style={styles.plusItem} onPress={() => { session.updateConfig('permission', id); setSheet('none'); }}>
              <Text style={{ color: colors.text, fontWeight: session.config.accessMode === id ? '700' : '400' }}>
                {title} {session.config.accessMode === id ? '✓' : ''}
              </Text>
              <Text style={{ color: colors.muted, fontSize: 11, marginTop: 2 }}>{desc}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {plus ? (
        <View style={[styles.plusMenu, { backgroundColor: colors.bg, borderColor: colors.line }]}>
          {Platform.OS === 'web' ? null : (
            <Pressable style={styles.plusItem} onPress={() => { void pickPhoto(true); }}>
              <Text style={{ color: colors.text, fontSize: 15 }}>📷 拍照附加</Text>
            </Pressable>
          )}
          <Pressable style={styles.plusItem} onPress={() => { void pickPhoto(false); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>🖼️ 上传图片</Text>
          </Pressable>
          <Pressable style={styles.plusItem} onPress={() => { void pickFile(); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>📄 上传文件</Text>
          </Pressable>
          {threadId ? (
            <Pressable style={styles.plusItem} onPress={() => { session.gitStatus(threadId); setPlus(false); }}>
              <Text style={{ color: colors.text, fontSize: 15 }}>🌿 查看 Git 状态</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.plusItem} onPress={() => { setDraft('/review '); setPlus(false); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>🔍 /review 代码审查</Text>
          </Pressable>
          <Pressable style={styles.plusItem} onPress={() => { setDraft('/compact '); setPlus(false); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>🗜️ /compact 压缩上下文</Text>
          </Pressable>
          <Pressable style={styles.plusItem} onPress={() => { setDraft('$ '); setPlus(false); }}>
            <Text style={{ color: colors.text, fontSize: 15 }}>💻 跑终端命令（$ 开头）</Text>
          </Pressable>
        </View>
      ) : null}

      {session.git ? (
        <Text selectable style={{ color: colors.muted, paddingHorizontal: 16, paddingBottom: 6, fontSize: 12 }}>
          {(session.git.error || [session.git.status, session.git.diff, session.git.log].filter(Boolean).join('\n')).slice(0, 4000)}
        </Text>
      ) : null}
      {session.commandOut ? (
        <Text selectable style={{ color: colors.muted, paddingHorizontal: 16, paddingBottom: 6, fontSize: 12 }}>
          {session.commandOut.slice(-4000)}
        </Text>
      ) : null}

      {/* Pending Attachment Chips */}
      {pending.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pendingBar}>
          {pending.map((p, idx) => (
            <View key={`${p.path}-${idx}`} style={[styles.pendingChip, { backgroundColor: colors.card, borderColor: colors.line }]}>
              <Text style={{ fontSize: 13 }}>{p.image ? '🖼️' : '📄'}</Text>
              <Text style={[styles.pendingName, { color: colors.text }]} numberOfLines={1}>{p.name}</Text>
              <Pressable
                onPress={() => setPending((prev) => prev.filter((_, i) => i !== idx))}
                hitSlop={8}
                style={styles.pendingRemove}
              >
                <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '700' }}>✕</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      ) : null}

      <View style={styles.composerRow}>
        <Pressable style={[styles.round, { backgroundColor: colors.shell }]} onPress={() => setPlus((v) => !v)} hitSlop={6}>
          <Text style={{ color: colors.text, fontSize: 22 }}>+</Text>
        </Pressable>
        <View style={[styles.inputPill, { backgroundColor: colors.shell }]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={threadId ? '随心输入，或以 $ 开头跑命令' : '先开一个会话'}
            placeholderTextColor={colors.muted}
            style={[styles.input, { color: colors.text }]}
            multiline
            editable={session.conn === 'connected' && !approval}
          />
        </View>
        {working && threadId ? (
          <Pressable style={[styles.send, { backgroundColor: colors.send }]} onPress={() => session.sendStop(threadId)}>
            <Text style={{ color: colors.sendText, fontWeight: '700' }}>停</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.send, { backgroundColor: colors.send, opacity: draft.trim() || pending.length ? 1 : 0.35 }]}
            onPress={send}
          >
            <Text style={{ color: colors.sendText, fontWeight: '700' }}>↑</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function quotaColor(remaining: number | null): string {
  if (remaining == null) return '#8e8ea0';
  const t = 1 - Math.max(0, Math.min(1, (remaining - 8) / 32));
  const r = Math.round(13 + (239 - 13) * t);
  const g = Math.round(13 + (68 - 13) * t);
  const b = Math.round(13 + (68 - 13) * t);
  return `rgb(${r},${g},${b})`;
}

function QuotaRing({ remaining }: { remaining: number | null }) {
  const color = quotaColor(remaining);
  const label = remaining == null ? '—' : String(Math.round(remaining));
  return (
    <View style={[styles.ring, { borderColor: color }]}>
      <Text style={{ color, fontSize: 9, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

function DiffNodeView({ node, onOpenFile }: { node: TimelineNode; onOpenFile: (path: string) => void }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={[styles.diffCard, { backgroundColor: colors.shell, borderColor: colors.line }]}>
      <View style={styles.diffHeader}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.diffPath, { color: colors.text }]} numberOfLines={1}>📝 已修改 {node.text}</Text>
          <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>
            <Text style={{ color: '#22c55e', fontWeight: '700' }}>+{node.add || 0}</Text>  <Text style={{ color: '#ef4444', fontWeight: '700' }}>-{node.del || 0}</Text>
          </Text>
        </View>
        <View style={styles.diffActions}>
          {node.patch ? (
            <Pressable style={[styles.diffBtn, { backgroundColor: colors.card }]} onPress={() => setExpanded((v) => !v)}>
              <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600' }}>{expanded ? '收起差异' : '查看差异'}</Text>
            </Pressable>
          ) : null}
          {node.path ? (
            <Pressable style={[styles.diffBtn, { backgroundColor: colors.card }]} onPress={() => node.path && onOpenFile(node.path)}>
              <Text style={{ color: colors.text, fontSize: 12, fontWeight: '600' }}>打开文件</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {expanded && node.patch ? (
        <ScrollView horizontal style={styles.patchScroll}>
          <Text selectable style={[styles.patchText, { color: colors.text }]}>{node.patch}</Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

function NodeView({
  node,
  mdStyle,
  onOpenFile,
}: {
  node: TimelineNode;
  mdStyle: Record<string, object>;
  onOpenFile: (path: string) => void;
}) {
  const { colors, theme } = useTheme();
  const [copied, setCopied] = useState(false);

  if (node.kind === 'user') {
    const ink = theme === 'light' ? '#fff' : '#111';
    const userMd = {
      body: { color: ink, fontSize: 16, lineHeight: 22 },
      heading1: { color: ink, fontSize: 20, fontWeight: '700' as const },
      heading2: { color: ink, fontSize: 18, fontWeight: '700' as const },
      paragraph: { color: ink },
      strong: { color: ink },
      em: { color: ink },
      link: { color: ink, textDecorationLine: 'underline' as const },
      code_inline: { color: ink, backgroundColor: 'rgba(127,127,127,0.25)' },
      fence: { color: ink, backgroundColor: 'rgba(127,127,127,0.2)' },
      bullet_list: { color: ink },
      ordered_list: { color: ink },
    };
    return (
      <View style={styles.userWrap}>
        <Pressable
          onLongPress={() => { void Clipboard.setStringAsync(node.text); }}
          style={[styles.userBubble, { backgroundColor: theme === 'light' ? '#111111' : '#e8e8e8' }]}
        >
          <Markdown style={userMd}>{node.text}</Markdown>
        </Pressable>
      </View>
    );
  }

  if (node.kind === 'assistant') {
    return (
      <View style={styles.assistantWrap}>
        <Pressable style={styles.assistant} onLongPress={() => { void Clipboard.setStringAsync(node.text); }}>
          <Markdown style={mdStyle}>{node.text}</Markdown>
        </Pressable>
        <Pressable
          style={[styles.copyIconBtn, { backgroundColor: colors.shell }]}
          onPress={() => {
            void Clipboard.setStringAsync(node.text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          hitSlop={6}
        >
          <Text style={{ fontSize: 11, color: colors.muted }}>{copied ? '✓ 已复制' : '复制'}</Text>
        </Pressable>
      </View>
    );
  }

  if (node.kind === 'command') {
    return (
      <View style={[styles.cmdCard, { backgroundColor: colors.shell, borderColor: colors.line }]}>
        <Text style={{ color: colors.muted, fontSize: 11, fontWeight: '700' }}>⚡ 执行终端</Text>
        <Text selectable style={[styles.cmdText, { color: colors.text }]}>{node.text}</Text>
      </View>
    );
  }

  if (node.kind === 'diff') {
    return <DiffNodeView node={node} onOpenFile={onOpenFile} />;
  }

  if (node.kind === 'system') {
    return (
      <View style={styles.systemWrap}>
        <Text style={{ color: colors.muted, fontSize: 12 }}>{node.text}</Text>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  round: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  titlePill: { flex: 1, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  ring: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  configBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  configPill: {
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  miniChip: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  mask: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.28)',
    justifyContent: 'center',
    padding: 24,
    zIndex: 20,
  },
  card: { borderRadius: 18, padding: 18, gap: 4 },
  cardK: { fontSize: 12, marginTop: 8 },
  cardV: { fontSize: 15, lineHeight: 22 },
  menuItem: { paddingVertical: 12 },
  feed: { paddingHorizontal: 16, paddingBottom: 16, flexGrow: 1, gap: 14 },
  userWrap: { alignItems: 'flex-end' },
  userBubble: { maxWidth: '82%', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10 },
  assistantWrap: { alignSelf: 'stretch', paddingRight: 8, position: 'relative' },
  assistant: { alignSelf: 'stretch', paddingRight: 24 },
  copyIconBtn: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, marginTop: 4 },
  cmdCard: { borderRadius: 10, borderWidth: 1, padding: 10, gap: 4 },
  cmdText: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13 },
  diffCard: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 8 },
  diffHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  diffPath: { fontSize: 14, fontWeight: '600' },
  diffActions: { flexDirection: 'row', gap: 6 },
  diffBtn: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  patchScroll: { maxHeight: 180, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.06)', padding: 8 },
  patchText: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, lineHeight: 16 },
  systemWrap: { alignItems: 'center', marginVertical: 4 },
  pad: { paddingHorizontal: 16, paddingBottom: 8 },
  floatingCapsuleWrap: { paddingHorizontal: 16, paddingBottom: 6, alignItems: 'center' },
  capsuleInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 6,
    maxWidth: '92%',
  },
  capsuleText: { fontSize: 12, fontWeight: '600' },
  pendingBar: { paddingHorizontal: 16, paddingBottom: 8, gap: 8, flexDirection: 'row' },
  pendingChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: 180,
  },
  pendingName: { fontSize: 12, maxWidth: 120 },
  pendingRemove: { padding: 2 },
  plusMenu: { marginHorizontal: 16, marginBottom: 8, borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  plusItem: { paddingVertical: 12, paddingHorizontal: 16 },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingBottom: 12,
    gap: 8,
  },
  inputPill: { flex: 1, borderRadius: 24, paddingHorizontal: 14, minHeight: 44, justifyContent: 'center' },
  input: { fontSize: 16, maxHeight: 120, paddingVertical: 10 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
