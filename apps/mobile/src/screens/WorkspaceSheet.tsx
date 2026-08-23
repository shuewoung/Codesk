import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import type { ThreadHistory, TimelineNode } from '../types';
import { useTheme } from '../theme-context';
import {
  buildPlanExecutePrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  filesMatchingPlanStep,
  planFromItems,
  reviewFilesFrom,
  type PlanStepStatus,
} from '../workspace';

const STATUS_LABEL: Record<PlanStepStatus, string> = {
  pending: '待做',
  in_progress: '进行中',
  completed: '完成',
};

export function WorkspaceSheet({
  mode,
  history,
  diffs,
  git,
  working,
  onClose,
  onSend,
  onRefreshGit,
  onOpenFile,
}: {
  mode: 'plan' | 'review';
  history?: ThreadHistory;
  diffs?: TimelineNode[];
  git?: { status?: string; diff?: string; log?: string; error?: string | null } | null;
  working?: boolean;
  onClose: () => void;
  onSend: (text: string, mode: 'plan' | 'review') => boolean;
  onRefreshGit?: () => void;
  onOpenFile?: (path: string) => void;
}) {
  const { colors } = useTheme();
  const { width, height } = useWindowDimensions();
  const phone = width < 700;
  const [draft, setDraft] = useState('');
  const plan = useMemo(() => planFromItems(history?.items), [history?.items]);
  const files = useMemo(
    () => reviewFilesFrom({ gitStatus: git?.status, gitDiff: git?.diff, diffs }),
    [git?.status, git?.diff, diffs],
  );

  useEffect(() => {
    if (mode === 'review') onRefreshGit?.();
  }, [mode]);

  const title = mode === 'plan' ? '规划' : '代码审查';
  const primary = mode === 'plan'
    ? (plan?.steps.length ? '更新计划' : '开始规划')
    : '开始审查';

  function sendPrimary() {
    const text = mode === 'plan' ? buildPlanPrompt(draft, plan) : buildReviewPrompt(draft, files, git?.status || '');
    if (onSend(text, mode)) setDraft('');
  }

  function sendExecute() {
    if (onSend(buildPlanExecutePrompt(plan), 'plan')) setDraft('');
  }

  return (
    <View style={[
      styles.wrap,
      phone ? { top: undefined, maxHeight: Math.round(height * 0.58), bottom: 8 } : null,
      { backgroundColor: colors.bg, borderColor: colors.line },
    ]}>
      <View style={styles.bar}>
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        <Pressable onPress={onClose} hitSlop={8}>
          <Text style={{ color: colors.muted, fontSize: 16 }}>✕</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 12, gap: 10 }}>
        {mode === 'plan' ? (
          plan?.steps.length ? (
            <>
              {plan.explanation ? <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>{plan.explanation}</Text> : null}
              {plan.steps.map((step, i) => (
                <Pressable
                  key={`${step.step}-${i}`}
                  onPress={() => {
                    const hits = filesMatchingPlanStep(step.step, diffs || []);
                    const path = hits[0]?.path || hits[0]?.text;
                    if (path) onOpenFile?.(path);
                  }}
                  style={[styles.step, { borderColor: colors.line }]}
                >
                  <Text style={{ color: step.status === 'completed' ? '#0d9488' : step.status === 'in_progress' ? '#d97706' : colors.muted, fontSize: 11, fontWeight: '700' }}>
                    {STATUS_LABEL[step.status]}
                  </Text>
                  <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>{i + 1}. {step.step}</Text>
                </Pressable>
              ))}
            </>
          ) : (
            <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 20 }}>
              还没有计划。写下目标后，Codex 会在这里列出步骤，确认后再执行。
            </Text>
          )
        ) : (
          <>
            {git?.error ? <Text style={{ color: '#ef4444', fontSize: 12 }}>{git.error}</Text> : null}
            {files.length ? files.map((file) => (
              <Pressable
                key={file.path}
                onPress={() => onOpenFile?.(file.path)}
                style={[styles.step, { borderColor: colors.line }]}
              >
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{file.path}</Text>
                <Text style={{ color: colors.muted, fontSize: 11 }}>
                  {file.status || '改动'}{file.add != null || file.del != null ? `  +${file.add || 0}/-${file.del || 0}` : ''}
                </Text>
              </Pressable>
            )) : (
              <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 20 }}>
                打开后会读取当前仓库改动。也可以写明要审查的范围。
              </Text>
            )}
          </>
        )}
        {working ? <Text style={{ color: colors.muted, fontSize: 12 }}>正在处理…步骤会随会话更新。</Text> : null}
      </ScrollView>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder={mode === 'plan' ? '补充目标或改某一步…' : '额外关注点，例如鉴权 / 并发'}
        placeholderTextColor={colors.muted}
        multiline
        style={[styles.input, { color: colors.text, borderColor: colors.line, backgroundColor: colors.shell }]}
      />
      <View style={styles.actions}>
        {mode === 'plan' && plan?.steps.length ? (
          <Pressable onPress={sendExecute} style={[styles.btn, { borderColor: colors.line }]}>
            <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13 }}>按此计划执行</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={sendPrimary} style={[styles.btn, styles.primary]}>
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>{primary}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 8,
    right: 8,
    top: 52,
    bottom: 8,
    borderRadius: 16,
    borderWidth: 1,
    padding: 12,
    zIndex: 30,
  },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { fontSize: 16, fontWeight: '700' },
  body: { flex: 1 },
  step: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 4 },
  input: { minHeight: 56, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, marginTop: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
  btn: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  primary: { backgroundColor: '#111827', borderColor: '#111827' },
});
