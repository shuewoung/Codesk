import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSession } from '../session';
import { useTheme } from '../theme-context';
import type { ComposerPending } from '../composer-draft';
import { stepStatus, queueStatus, isQueueSubmissionCancelled } from '../utils/thread-ui';

/** Explicit, server-backed continuation controls. Never auto-send or auto-adopt a draft. */
export function ThreadContinuity({ threadId, text, attachments, onAdopt, canQueue }: {
  threadId: string; text: string; attachments: ComposerPending[];
  onAdopt: (text: string, attachments: ComposerPending[]) => void; canQueue: boolean;
}) {
  const session = useSession();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [queuedSnapshot, setQueuedSnapshot] = useState('');
  const previousQueueRequestId = useRef<string | undefined>(undefined);
  const snapshot = JSON.stringify([threadId, text, attachments]);
  const latestSnapshot = useRef(snapshot); latestSnapshot.current = snapshot;
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const queueRequest = session.requestState('queue_message', threadId);
  const execution = session.executionStates[threadId];
  const queue = session.queues[threadId] || [];
  const submissionCancelled = queueRequest?.requestId !== previousQueueRequestId.current && isQueueSubmissionCancelled(queue, queueRequest?.requestId);
  const sameQueuedInput = queuedSnapshot === snapshot && queueRequest?.status !== 'error' && !submissionCancelled;
  const waitingCount = queue.filter(item => ['queued', 'pending'].includes(item.status)).length;
  const sync = session.draftSync[threadId];
  const connected = session.conn === 'connected';
  const supported = (command: string) => connected && session.capabilities[command] === true;
  const canReadExecution = supported('get_execution_state');
  const canReadQueue = supported('list_queue');
  const { getExecutionState, listQueue, getDraft } = session;
  useEffect(() => {
    setOpen(false);
    if (canReadExecution) getExecutionState(threadId);
    if (canReadQueue) listQueue(threadId);
  }, [threadId, canReadExecution, canReadQueue, getExecutionState, listQueue]);
  const action = (label: string, run: () => void, disabled = false) => <Pressable accessibilityRole="button" disabled={disabled} accessibilityState={{ disabled }} onPress={run} style={{ paddingVertical: 7, opacity: disabled ? 0.45 : 1 }}><Text style={{ color: colors.text, fontSize: 12 }}>{label}</Text></Pressable>;
  return <View style={{ paddingHorizontal: 16, borderTopWidth: 0.5, borderColor: colors.line }}>
    {action(`交接 / 排队 / 同步草稿${waitingCount ? ` · 待执行 ${waitingCount}` : ''}${sync?.status === 'conflict' ? ' · 草稿冲突' : ''}`, () => { setOpen(!open); if (!open) { if (canReadExecution) getExecutionState(threadId); if (canReadQueue) listQueue(threadId); if (supported('get_draft')) getDraft(threadId); } })}
    {open ? <ScrollView style={{ maxHeight: 230 }} keyboardShouldPersistTaps="handled">
      <Text style={{ color: colors.muted, fontSize: 11 }}>仅宿主机明确支持的能力可操作；灰色按钮表示离线、能力未提供或当前状态不允许。</Text>
      <Text style={{ color: colors.muted, fontSize: 12 }}>执行位置：{execution?.location === 'desktop' ? '桌面' : execution?.location === 'hub' ? 'Hub' : '尚未确认'} · {stepStatus(execution?.status)}</Text>
      <Text style={{ color: colors.muted, fontSize: 11 }}>{execution?.reason || '交接仅在服务端确认可安全释放时允许；其他运行中的会话可能阻塞。'}</Text>
      {action('安全交接给桌面', () => { session.handoffThread(threadId); }, !supported('handoff_thread') || !execution?.canHandoff)}
      {action('刷新执行位置与队列', () => { if (canReadExecution) getExecutionState(threadId); if (canReadQueue) listQueue(threadId); }, !canReadExecution && !canReadQueue)}
      <Text style={{ color: colors.muted, fontSize: 11 }}>排队会在服务端条件满足后执行，不等同于仅保存草稿。</Text>
      {action('将当前输入加入执行队列', () => {
        const input = attachments.map(p => p.skill ? { type: 'skill', name: p.name, path: p.path } : p.image ? { type: 'localImage', path: p.path } : { type: 'mention', name: p.name, path: p.path });
        if (session.queueMessage(threadId, text, input)) {
          previousQueueRequestId.current = queueRequest?.requestId;
          setQueuedSnapshot(snapshot);
        }
      }, !supported('queue_message') || sameQueuedInput || queueRequest?.status === 'loading' || !canQueue || !text.trim() && !attachments.length)}
      {sameQueuedInput ? <Text accessibilityLiveRegion="polite" style={{ color: colors.muted, fontSize: 12 }}>已提交排队请求；原输入仍保留，请勿重复发送。请在下方队列核对宿主机确认的消息与编号。</Text> : null}
      {submissionCancelled && queuedSnapshot === snapshot ? <Text style={{ color: colors.muted, fontSize: 12 }}>宿主机已确认原排队消息取消；当前输入仍保留，可主动重新加入队列。</Text> : null}
      {queueRequest?.error ? <Text style={{ color: colors.danger, fontSize: 12 }}>{queueRequest.error}</Text> : null}
      {queue.length ? queue.map(item => <View key={item.queueId} style={{ paddingVertical: 6 }}><Text numberOfLines={2} style={{ color: colors.text, fontSize: 12 }}>{item.text || '附件消息'} · {queueStatus(item.status)}</Text><Text selectable style={{ color: colors.muted, fontSize: 10 }}>编号：{item.queueId}</Text>{action('取消此排队消息', () => { session.cancelQueuedMessage(threadId, item.queueId); }, !supported('cancel_queued_message') || !['queued', 'pending'].includes(item.status))}</View>) : <Text style={{ color: colors.muted, fontSize: 11 }}>当前未显示排队消息；可刷新核对。</Text>}
      <Text style={{ color: colors.muted, fontSize: 11 }}>草稿默认保存在本机。同步只保存，不会发送；采用远端会替换当前输入。</Text>
      {action('同步当前草稿到宿主机', () => { session.saveDraft(threadId, text, attachments); }, !supported('save_draft') || sync?.status === 'saving' || sync?.status === 'conflict')}
      <Text accessibilityLiveRegion="polite" style={{ color: sync?.error ? colors.danger : colors.muted, fontSize: 12 }}>{sync?.error || (sync?.status === 'synced' ? '远端草稿已读取 / 同步' : sync?.status === 'conflict' ? '草稿版本冲突，请比较后选择' : sync?.status === 'saving' ? '正在同步…' : '')}</Text>
      {sync?.remote ? <Text selectable numberOfLines={4} style={{ color: colors.muted, fontSize: 12 }}>远端 v{sync.remote.version}：{sync.remote.text || '空文本'} · 附件：{sync.remote.attachments.map(file => file.name).join('、') || '无'}</Text> : null}
      {sync?.status === 'conflict' ? action('保留本地版本并解决冲突', () => { void session.resolveDraftConflict(threadId, 'local'); }, !supported('save_draft')) : null}
      {sync?.remote ? action('采用远端草稿到输入框（不发送）', () => {
        const remote = sync.remote!;
        if (sync.status === 'conflict') void session.resolveDraftConflict(threadId, 'remote').then(ok => { if (ok && live.current && latestSnapshot.current === snapshot) onAdopt(remote.text, remote.attachments); });
        else onAdopt(remote.text, remote.attachments);
      }, !connected || sync.status === 'saving') : null}
    </ScrollView> : null}
  </View>;
}
