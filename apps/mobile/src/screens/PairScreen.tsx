import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ErrorBanner, GhostButton, PrimaryButton } from '../components/ui';
import { useSession } from '../session';
import { radius, space } from '../theme';
import { useTheme } from '../theme-context';

export function PairScreen({ onScan }: { onScan: () => void }) {
  const session = useSession();
  const { colors } = useTheme();
  const [homeCode, setHomeCode] = useState('');
  const [lanUrl, setLanUrl] = useState(session.lanUrl);
  const [outCode, setOutCode] = useState('');
  const [busy, setBusy] = useState<'home' | 'out' | ''>('');
  const [localError, setLocalError] = useState('');
  const [discoverHint] = useState(session.lanUrl ? '将使用上次家里地址，未连家里 WiFi 请走出门。' : '');

  function fail(err: unknown, fallback: string) {
    const raw = err instanceof Error ? err.message : fallback;
    setLocalError(/network request failed/i.test(raw)
      ? '网络不通。家里要同一 WiFi；出门要中继能连上。'
      : raw);
  }

  async function submitHome() {
    setLocalError('');
    session.clearError();
    const code = homeCode.trim();
    const url = lanUrl.trim() || session.lanUrl;
    if (!code) {
      setLocalError('请输入主机台左边的家里码。');
      return;
    }
    if (!url) {
      setLocalError('请填写电脑地址，主机台左边标「常用」的那个。');
      return;
    }
    setBusy('home');
    try {
      await session.loginLan(url, code);
    } catch (err) {
      fail(err, '家里连接失败');
    } finally {
      setBusy('');
    }
  }

  async function submitOut() {
    setLocalError('');
    session.clearError();
    const code = outCode.trim();
    if (!code) {
      setLocalError('请输入主机台右边的出门码，或扫右边的二维码。');
      return;
    }
    setBusy('out');
    try {
      await session.pair(code, session.relayUrl);
    } catch (err) {
      fail(err, '出门连接失败');
    } finally {
      setBusy('');
    }
  }

  const card = { backgroundColor: colors.card, borderColor: colors.line };

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: colors.bg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
        <Text style={[styles.brand, { color: colors.text }]}>Codesk</Text>
        <Text style={[styles.lead, { color: colors.muted }]}>家里码和出门码不是同一个。看电脑主机台：左家里，右出门。</Text>
        <ErrorBanner text={localError || session.error} onClose={() => { setLocalError(''); session.clearError(); }} />

        <View style={[styles.card, card]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>家里 WiFi</Text>
          <Text style={[styles.cardHint, { color: colors.muted }]}>用主机台左边的常驻家里码。同一局域网，不经中继。</Text>
          {discoverHint ? <Text style={[styles.cardHint, { color: colors.text }]}>{discoverHint}</Text> : null}
          <TextInput
            value={homeCode}
            onChangeText={(v) => setHomeCode(v.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="家里码"
            placeholderTextColor={colors.muted}
            style={[styles.input, { backgroundColor: colors.shell, color: colors.text, borderColor: colors.line }]}
            returnKeyType="next"
          />
          <TextInput
            value={lanUrl}
            onChangeText={setLanUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://192.168.x.x:18990"
            placeholderTextColor={colors.muted}
            style={[styles.url, { backgroundColor: colors.shell, color: colors.text, borderColor: colors.line }]}
            returnKeyType="go"
            onSubmitEditing={() => { void submitHome(); }}
          />
          <PrimaryButton label="连接家里" busy={busy === 'home'} disabled={!!busy} onPress={() => { void submitHome(); }} />
        </View>

        <View style={[styles.card, card]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>出门</Text>
          <Text style={[styles.cardHint, { color: colors.muted }]}>用主机台右边的一次性出门码。中继没连上就出不了这个码。</Text>
          <TextInput
            value={outCode}
            onChangeText={(v) => setOutCode(v.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="出门码"
            placeholderTextColor={colors.muted}
            style={[styles.input, { backgroundColor: colors.shell, color: colors.text, borderColor: colors.line }]}
            returnKeyType="go"
            onSubmitEditing={() => { void submitOut(); }}
          />
          <PrimaryButton label="连接出门" busy={busy === 'out'} disabled={!!busy} onPress={() => { void submitOut(); }} />
          {Platform.OS === 'web' ? null : <GhostButton label="扫描出门二维码" onPress={onScan} />}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  inner: { padding: space.lg, paddingBottom: 64, gap: space.md, justifyContent: 'center', flexGrow: 1 },
  brand: { fontSize: 32, fontWeight: '700' },
  lead: { fontSize: 14, lineHeight: 20, marginBottom: space.xs },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: space.md, gap: space.sm },
  cardTitle: { fontSize: 18, fontWeight: '700' },
  cardHint: { fontSize: 13, lineHeight: 18 },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    fontSize: 20,
    letterSpacing: 4,
    textAlign: 'center',
  },
  url: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    fontSize: 14,
  },
});
