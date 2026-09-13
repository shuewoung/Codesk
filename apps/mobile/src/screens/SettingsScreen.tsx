import * as Clipboard from 'expo-clipboard';
import React, { useRef, useState } from 'react';
import { Alert, Linking, Platform,  ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AccessiblePressable as Pressable, ErrorBanner, GhostButton, PrimaryButton } from '../components/ui';
import { HandshakePanel } from '../components/HandshakePanel';
import { buildHandshake } from '../handshake';
import { useSession } from '../session';
import { radius, space } from '../theme';
import { useTheme } from '../theme-context';
import { ACCESS_MODES } from '../types';

const CURRENT_VERSION = '1.0.10';
const CURRENT_VERSION_CODE = 110;

export function SettingsScreen({ onBack, onScan }: { onBack: () => void; onScan: () => void }) {
  const session = useSession();
  const { colors, theme, setTheme, listDensity, setListDensity, showProcess, setShowProcess } = useTheme();
  const [relayUrl, setRelayUrl] = useState(session.relayUrl);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const logoutLock = useRef(false);
  const [logoutError, setLogoutError] = useState('');
  const [diagnosticMessage, setDiagnosticMessage] = useState('');
  const diagnosticHandshake = buildHandshake({ mode: session.mode, phase: session.handshake.phase });
  const diagnosticReport = JSON.stringify({ version: CURRENT_VERSION, platform: Platform.OS,
    ...session.diagnostics, phase: diagnosticHandshake.phase,
    steps: diagnosticHandshake.steps.map(({ key, state }) => ({ key, state })),
  }, null, 2);
  async function logout(localOnly = false) {
    if (logoutLock.current) return;
    logoutLock.current = true;
    setBusy(true);
    setLogoutError('');
    try { await session.logout({ localOnly }); }
    catch (error) { setLogoutError(error instanceof Error ? error.message : '退出失败，已保留本机登录，请重试'); }
    finally { logoutLock.current = false; setBusy(false); }
  }
  function confirmLogout(localOnly = false) {
    const title = localOnly ? '仅在本机退出？' : '退出并撤销远程登录？';
    const detail = localOnly ? '只清除本机凭据，远程授权可能仍有效。请稍后在电脑主机台撤销设备。' : '远程确认成功后才清除本机凭据；失败会保留登录以便重试。';
    const run = () => { void logout(localOnly); };
    if (Platform.OS === 'web') { if (typeof window !== 'undefined' && window.confirm(`${title}
${detail}`)) run(); }
    else Alert.alert(title, detail, [{ text: '取消', style: 'cancel' }, { text: '确认退出', style: 'destructive', onPress: run }]);
  }
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
      <Text style={[styles.label, { color: colors.muted }]}>本包能力</Text>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 20 }}>
        当前 v{CURRENT_VERSION}。出门须含 E2E 的 APK，并扫带 hk= 的出门码。
        {Platform.OS === 'android' ? ' 极光推送仅正式 APK 有效，Expo Go 收不到。' : ''}
        {Platform.OS === 'web' ? ' 浏览器没有推送和相机扫码。' : ''}
        旧包连上中继却一直「握手中」，请到 codesk.icu 装新包后重扫右边码。
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
          accessibilityState={{ selected: theme === 'light' }}
          onPress={() => setTheme('light')}
        >
          <Text style={{ color: colors.text }}>浅色</Text>
        </Pressable>
        <Pressable
          style={[styles.chip, { borderColor: colors.line, backgroundColor: theme === 'dark' ? colors.card : 'transparent' }]}
          accessibilityState={{ selected: theme === 'dark' }}
          onPress={() => setTheme('dark')}
        >
          <Text style={{ color: colors.text }}>深色</Text>
        </Pressable>
      </View>
      <Text style={[styles.label, { color: colors.muted }]}>会话列表</Text>
      <View style={styles.row}>
        <Pressable
          style={[styles.chip, { borderColor: colors.line, backgroundColor: listDensity === 'compact' ? colors.card : 'transparent' }]}
          accessibilityState={{ selected: listDensity === 'compact' }}
          onPress={() => setListDensity('compact')}
        >
          <Text style={{ color: colors.text }}>紧凑</Text>
        </Pressable>
        <Pressable
          style={[styles.chip, { borderColor: colors.line, backgroundColor: listDensity === 'comfortable' ? colors.card : 'transparent' }]}
          accessibilityState={{ selected: listDensity === 'comfortable' }}
          onPress={() => setListDensity('comfortable')}
        >
          <Text style={{ color: colors.text }}>宽松</Text>
        </Pressable>
      </View>
      <Text style={[styles.label, { color: colors.muted }]}>时间线</Text>
      <View style={styles.row}>
        <Pressable
          style={[styles.chip, { borderColor: colors.line, backgroundColor: showProcess ? colors.card : 'transparent' }]}
          accessibilityState={{ selected: showProcess }}
          onPress={() => setShowProcess(true)}
        >
          <Text style={{ color: colors.text }}>显示过程</Text>
        </Pressable>
        <Pressable
          style={[styles.chip, { borderColor: colors.line, backgroundColor: !showProcess ? colors.card : 'transparent' }]}
          accessibilityState={{ selected: !showProcess }}
          onPress={() => setShowProcess(false)}
        >
          <Text style={{ color: colors.text }}>隐藏过程</Text>
        </Pressable>
      </View>
      <Text style={{ color: colors.muted, fontSize: 12 }}>关掉后不显示思考、命令和子智能体过程，只留对话和改文件。</Text>
      <Text style={[styles.label, { color: colors.muted }]}>访问权限 · Hub 全局设置</Text>
      <Text style={{ color: colors.muted, fontSize: 12 }}>服务端回执仅确认已保存 Hub 全局配置；Hub 新轮次按支持字段提交，桌面接续 / 当前轮次由执行端决定。速度配置保存不代表 serviceTier 已生效。离线不可变更。</Text>
      <View style={styles.row}>
        {(Object.keys(ACCESS_MODES) as (keyof typeof ACCESS_MODES)[]).map((id) => (
          <Pressable
            key={id}
            unstable_pressDelay={0}
            style={[
              styles.chip,
              {
                borderColor: colors.line,
                backgroundColor: session.config.accessMode === id ? colors.card : 'transparent',
              },
            ]}
            disabled={session.conn !== 'connected'}
            accessibilityState={{ selected: session.config.accessMode === id, disabled: session.conn !== 'connected' }}
            onPress={() => session.updateConfig('permission', id)}
          >
            <Text style={{ color: colors.text }}>{ACCESS_MODES[id].icon} {ACCESS_MODES[id].label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={{ color: colors.muted, fontSize: 12 }}>
        {ACCESS_MODES[(session.config.accessMode === 'ask' || session.config.accessMode === 'auto' || session.config.accessMode === 'full') ? session.config.accessMode : 'full'].hint}
      </Text>
      <Text style={[styles.label, { color: colors.muted }]}>当前连接</Text>
      <Text style={{ color: colors.text, fontSize: 15 }}>
        {session.conn === 'connected'
          ? (session.mode === 'lan' ? '直连' : '中继')
          : session.connText}
      </Text>
      <Text style={[styles.label, { color: colors.muted }]}>连接诊断（已脱敏）</Text>
      <Text selectable style={{ color: colors.muted }}>{session.diagnostics.endpoint || '尚未连接'}</Text>
      <HandshakePanel handshake={diagnosticHandshake} onRetry={session.reconnect} retryLabel="重新连接" />
      <Text style={{ color: colors.muted }}>待响应请求：{session.diagnostics.pendingRequests}</Text>
      <GhostButton label="复制脱敏诊断报告" onPress={() => {
        void Clipboard.setStringAsync(diagnosticReport).then(() => setDiagnosticMessage('诊断报告已复制'), () => setDiagnosticMessage('复制失败，请重试'));
      }} />
      <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>{diagnosticMessage}</Text>
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
      <Text style={{ color: colors.text, fontSize: 13 }}>当前版本：v{CURRENT_VERSION}</Text>
      {updateMsg ? <Text style={{ color: colors.muted, fontSize: 12 }}>{updateMsg}</Text> : null}
      <GhostButton
        label={checkingUpdate ? '正在检查更新...' : '检查版本更新'}
        onPress={handleCheckUpdate}
      />
      <GhostButton label="官网 codesk.icu" onPress={() => { void Linking.openURL('https://codesk.icu'); }} />
      <GhostButton label="GitHub" onPress={() => { void Linking.openURL('https://github.com/shuewoung/codesk'); }} />
      <ErrorBanner text={logoutError} />
      <PrimaryButton label={logoutError ? '重试退出并撤销授权' : '退出并撤销远程登录'} danger busy={busy} onPress={() => confirmLogout()} />
      {logoutError ? <>
        <Text style={{ color: colors.muted }}>远程退出未确认，已保留登录。仅本地退出不会撤销远程授权。</Text>
        <GhostButton label="仅在本机退出" disabled={busy} onPress={() => confirmLogout(true)} />
      </> : null}
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
