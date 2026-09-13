import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSession } from '../session';
import { useTheme } from '../theme-context';
import type { UserInputRequest } from '../types';
import { userInputAnswers, inputSubmissionOutcome } from '../utils/thread-ui';

/** The parent removes a request only after the session receives user_input_resolved. */
export function UserInputBar({ request }: { request: UserInputRequest }) {
  const session = useSession();
  const { colors } = useTheme();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const sending = useRef(false);
  const submittedRequestId = useRef<string | undefined>(undefined);
  const previousRequestId = useRef<string | undefined>(undefined);
  const [submitError, setSubmitError] = useState('');
  const [timedOut, setTimedOut] = useState(false);
  const submission = session.requestState('send_user_input', request.threadId);
  useEffect(() => {
    if (!sending.current || !submission) return;
    if (!submittedRequestId.current && submission.requestId !== previousRequestId.current) submittedRequestId.current = submission.requestId;
    const outcome = inputSubmissionOutcome(submission, submittedRequestId.current);
    if (outcome === 'failed') {
      sending.current = false;
      setSubmitted(false);
      setTimedOut(false);
      setSubmitError(submission.error || '宿主机明确拒绝了回答，请检查后重新提交。');
    } else if (outcome === 'uncertain') setTimedOut(true);
  }, [submission]);
  const connected = session.conn === 'connected';
  const supported = session.capabilities.send_user_input === true;
  const payload = userInputAnswers(request, answers);
  const questions = request.payload.questions || [];
  const disabled = !connected || !supported || submitted;
  const anotherPending = !submitted && (submission?.status === 'loading' || submission?.status === 'timeout');
  return <View style={{ marginHorizontal: 16, padding: 12, borderWidth: 1, borderColor: colors.line, borderRadius: 10, backgroundColor: colors.shell }}>
    <Text style={{ color: colors.text, fontWeight: '700' }}>需要补充输入</Text>
    <ScrollView style={{ maxHeight: 240 }} keyboardShouldPersistTaps="handled">
      {questions.map(question => <View key={question.id} style={{ paddingVertical: 8, gap: 6 }}>
        {question.header ? <Text style={{ color: colors.muted, fontSize: 11 }}>{question.header}</Text> : null}
        <Text style={{ color: colors.text }}>{question.question}</Text>
        {(question.options || []).map(option => <Pressable key={option.label} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ checked: answers[question.id] === option.label, disabled }} disabled={disabled} onPress={() => setAnswers(previous => ({ ...previous, [question.id]: option.label }))} style={{ padding: 8, borderWidth: 1, borderColor: answers[question.id] === option.label ? colors.text : colors.line, borderRadius: 6 }}>
          <Text style={{ color: colors.text }}>{option.label}</Text>
          {option.description ? <Text style={{ color: colors.muted, fontSize: 11 }}>{option.description}</Text> : null}
        </Pressable>)}
        <TextInput accessibilityLabel={`${question.question} · 自由填写`} placeholder="也可自由填写回答" placeholderTextColor={colors.muted} value={answers[question.id] || ''} onChangeText={text => setAnswers(previous => ({ ...previous, [question.id]: text }))} editable={!disabled} secureTextEntry={question.isSecret === true} autoCapitalize="none" style={{ padding: 9, borderWidth: 1, borderColor: colors.line, borderRadius: 6, color: colors.text, backgroundColor: colors.bg }} />
      </View>)}
      {!questions.length ? <Text style={{ color: colors.muted }}>宿主机未提供可回答的问题，请在执行端处理。</Text> : null}
    </ScrollView>
    <Text accessibilityLiveRegion="polite" style={{ color: colors.muted, fontSize: 12, marginVertical: 6 }}>{timedOut ? '回答确认超时，结果未知；不会自动重发。请在执行端核对，或等待原请求回执。' : submitted ? '回答已提交，等待宿主机确认；确认解决后此卡片才会消失，请勿重复提交。' : anotherPending ? '此会话仍有补充回答等待确认，请勿重复提交。' : !connected ? '离线：可查看问题，恢复连接后再回答。' : !supported ? '宿主机未提供补充输入能力，请在执行端处理。' : '请回答全部问题；选择选项不会自动发送。'}</Text>
    {submitError ? <Text accessibilityLiveRegion="polite" style={{ color: colors.danger, fontSize: 12 }}>{submitError}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="提交补充回答" accessibilityState={{ disabled: disabled || anotherPending || !payload, busy: submitted }} disabled={disabled || anotherPending || !payload} onPress={() => {
      if (sending.current || disabled || anotherPending || !payload) return;
      sending.current = true;
      previousRequestId.current = submission?.requestId;
      submittedRequestId.current = undefined;
      setSubmitError('');
      setTimedOut(false);
      if (session.respondUserInput(request.requestId, payload)) setSubmitted(true);
      else sending.current = false;
    }} style={{ paddingVertical: 8, opacity: disabled || anotherPending || !payload ? 0.45 : 1 }}><Text style={{ color: colors.text, fontWeight: '600' }}>{submitted ? '等待确认' : submitError ? '重新提交回答' : '提交回答'}</Text></Pressable>
  </View>;
}
