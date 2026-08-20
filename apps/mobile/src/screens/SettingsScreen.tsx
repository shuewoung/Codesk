import * as Clipboard from 'expo-clipboard';
import React, { useState } from 'react';
import { Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ErrorBanner, GhostButton, PrimaryButton } from '../components/ui';
import { useSession } from '../session';
import { radius, space } from '../theme';
import { useTheme } from '../theme-context';

const CURRENT_VERSION = '1.0.6';
const CURRENT_VERSION_CODE = 106;

export function SettingsScreen({ onBack, onScan }: { onBack: () => void; onScan: () => void }) {
  const session = useSession();
  const { colors, theme, setTheme } = useTheme();
  const [relayUrl, setRelayUrl] = useState(session.relayUrl);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateMsg('');
    try {
      const res = await fetch('https://codesk.icu/version.json');
      if (!res.ok) throw new Error('网络异常');
      const data = (await res.json()) as { version?: string; versionCode?: number; changelog?: string; downloadUrl?: string };
      if (data.versionCode && data.versionCode > CURRENT_VERSION_CODE) {
        Alert.alert(
          `发现新版本 v${data.version || ''}`,
          `${data.changelog || '优化体验与修复已知问题'}\n\n是否立即前往下载？`,
          [
            { text: '稍后再说', style: 'cancel' },
            {
              text: '立即下载',
              onPress: () => {
                void Linking.openURL(data.downloadUrl || 'https://codesk.icu/codesk-latest.apk');
              },
            },
          ]
        );
      } else {
        setUpdateMsg(`当前已是最新版本 (v${CURRENT_VERSION})`);
        setTimeout(() => setUpdateMsg(''), 3500);
      }
    } catch {
      setUpdateMsg('检查失败：请检查网络');
      setTimeout(() => setUpdateMsg(''), 3500);
    } finally {
      setCheckingUpdate(false);
    }
  };

  return (
    <ScrollView style={[styles.root, { backgroundColor: colors.bg }]} contentContainerStyle={styles.inner}>
      <Pressable onPress={onBack}>
        <Text style={{ color: colors.text, fontSize: 16 }}>返回</Text>
      </Pressable>
      <Text style={[styles.title, { color: colors.text }]}>Codesk</Text>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 20 }}>
        本机 Codex 的远程控制面。家里直连电脑，出门经中继。家里码和出门码不是同一个。
      </Text>
      <Text style={[styles.label, { color: colors.muted }]}>推送</Text>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 20 }}>
        审批和任务完成走极光推送（仅 Android）。Expo Go / Web 收不到。正式 APK 会自动登记，无需在 Hub 里填密钥。
      </Text>
      <ErrorBanner text={session.error} onClose={session.clearError} />
      <Text style={[styles.label, { color: colors.muted }]}>外观</Text>
      <View style={styles.row}>
        <Pressable
          style={[styles.chip, { borderColor: colors.line, backgroundColor: theme === 'light' ? colors.card : 'transparent' }]}
          onPress={() => setTheme('light')}
        >
          <Text style={{ color: colors.text }}>浅色</Text>
        </Pressable>
        <Pressable
          style={[styles.chip, { borderColor: colors.line, backgroundColor: theme === 'dark' ? colors.card : 'transparent' }]}
          onPress={() => setTheme('dark')}
        >
          <Text style={{ color: colors.text }}>深色</Text>
        </Pressable>
      </View>
      <Text style={[styles.label, { color: colors.muted }]}>访问权限</Text>
      <View style={styles.row}>
        {[
          ['ask', '请求批准'],
          ['auto', '帮我批准'],
          ['full', '完全访问'],
        ].map(([id, label]) => (
          <Pressable
            key={id}
            style={[
              styles.chip,
              {
                borderColor: colors.line,
                backgroundColor: session.config.accessMode === id ? colors.card : 'transparent',
              },
            ]}
            onPress={() => session.updateConfig('permission', id)}
          >
            <Text style={{ color: colors.text }}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={[styles.label, { color: colors.muted }]}>当前连接</Text>
      <Text style={{ color: colors.text, fontSize: 15 }}>
        {session.conn === 'connected'
          ? (session.mode === 'lan' ? '家里直连' : '中继（出门）')
          : session.connText}
      </Text>
      {session.mode === 'lan' && session.lanUrl ? (
        <Text selectable style={{ color: colors.muted, fontSize: 13 }}>{session.lanUrl}</Text>
      ) : null}
      <Text style={[styles.label, { color: colors.muted }]}>中继地址</Text>
      <TextInput
        value={relayUrl}
        onChangeText={setRelayUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://hub.codesk.icu:8787"
        placeholderTextColor={colors.muted}
        style={[styles.input, { backgroundColor: colors.shell, color: colors.text, borderColor: colors.line }]}
      />
      <GhostButton label="保存中继地址" onPress={() => { void session.setRelayUrl(relayUrl); }} />
      {Platform.OS === 'web' ? null : <PrimaryButton label="扫描出门二维码" onPress={onScan} />}
      <Text style={[styles.label, { color: colors.muted }]}>当前 hubId</Text>
      <Text selectable style={{ color: colors.text, fontSize: 13 }}>
        {session.hubId || '尚未配对'}
      </Text>
      <GhostButton
        label={copied ? '已复制' : '复制 hubId'}
        onPress={() => {
          if (!session.hubId) return;
          void Clipboard.setStringAsync(session.hubId).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      />
      <Text style={[styles.label, { color: colors.muted }]}>版本与更新</Text>
      <Text style={{ color: colors.text, fontSize: 13 }}>当前版本：v1.0.6</Text>
      {updateMsg ? <Text style={{ color: colors.muted, fontSize: 12 }}>{updateMsg}</Text> : null}
      <GhostButton
        label={checkingUpdate ? '正在检查更新...' : '检查版本更新'}
        onPress={handleCheckUpdate}
      />
      <GhostButton label="官网 codesk.icu" onPress={() => { void Linking.openURL('https://codesk.icu'); }} />
      <GhostButton label="GitHub" onPress={() => { void Linking.openURL('https://github.com/shuewoung/codesk'); }} />
      <PrimaryButton
        label="退出并吊销此设备"
        danger
        busy={busy}
        onPress={() => {
          setBusy(true);
          void session.logout().finally(() => setBusy(false));
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  inner: { padding: space.lg, gap: space.sm },
  title: { fontSize: 24, fontWeight: '700', marginVertical: space.sm },
  label: { fontSize: 12, marginTop: space.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 8 },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    fontSize: 16,
  },
});
