import { AccessiblePressable as Pressable } from '../components/ui';
import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Dimensions, Linking, Platform,  StyleSheet, Text, View } from 'react-native';
import { extractPairFromInput } from '../protocol';
import { useSession } from '../session';

const FRAME = 248;

function friendlyPairError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || '');
  if (/too many|rate_limited|429/i.test(raw)) return '扫太快了，等两分钟或改手输。';
  if (/过期|expired|配对码不对|用过/i.test(raw)) return '这个码用过了或过期了，请在电脑上点「刷新出门码」再扫右边。';
  if (/network request failed/i.test(raw)) return '手机连不上电脑或中继。先确认同一 WiFi，电脑 Hub 已开。';
  return raw || '配对失败';
}

export function ScanScreen({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [localError, setLocalError] = useState('');
  const locked = useRef(false);
  const permissionLock = useRef(false);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void getPermission().catch(() => setLocalError('无法读取相机权限，请返回手输。'));
    });
    return () => subscription.remove();
  }, [getPermission]);
  async function allowCamera() {
    if (permissionLock.current) return;
    permissionLock.current = true;
    setPermissionBusy(true);
    try {
      if (permission?.canAskAgain === false) await Linking.openSettings();
      else await requestPermission();
    } catch { setLocalError('无法打开相机权限，请在系统设置中允许相机，或返回手输。'); }
    finally { permissionLock.current = false; setPermissionBusy(false); }
  }
  const box = Math.min(FRAME, Math.round(Dimensions.get('window').width * 0.68));

  async function handleData(data: string) {
    if (locked.current) return;
    const parsed = extractPairFromInput(data);
    if (!/^[A-Z0-9]{4,12}$/i.test(parsed.code) || (parsed.relayUrl && !/^https?:\/\//i.test(parsed.relayUrl))) {
      locked.current = true;
      setScanned(true);
      setLocalError('无效二维码，请扫描主机台右边的出门二维码。');
      return;
    }
    locked.current = true;
    setScanned(true);
    setBusy(true);
    setLocalError('');
    try {
      await session.pair(data, parsed.relayUrl || session.relayUrl);
      onClose();
    } catch (err) {
      setLocalError(friendlyPairError(err));
      setBusy(false);
    }
  }

  function retry() {
    locked.current = false;
    setScanned(false);
    setCameraError(false);
    setBusy(false);
    setLocalError('');
  }

  if (Platform.OS === 'web') {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>请手输主机台右边的出门码</Text>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.textBtn}><Text style={styles.textBtnLabel}>返回</Text></Pressable>
      </View>
    );
  }

  if (!permission) return <View style={styles.fallback}>
    <ActivityIndicator color="#fff" />
    <Text accessibilityLiveRegion="polite" style={styles.fallbackText}>正在检查相机权限…</Text>
    <Pressable accessibilityRole="button" onPress={onClose} style={styles.textBtn}><Text style={styles.textBtnLabel}>返回手输</Text></Pressable>
  </View>;

  if (!permission.granted) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>{permission.canAskAgain ? '需要相机权限才能扫码' : '相机权限已关闭，请到系统设置中允许相机'}{localError ? `
${localError}` : ''}</Text>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: permissionBusy, busy: permissionBusy }} disabled={permissionBusy} onPress={() => { void allowCamera(); }} style={styles.solidBtn}>
          <Text style={styles.solidLabel}>{permissionBusy ? '正在打开…' : permission.canAskAgain ? '允许相机' : '打开系统设置'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.textBtn}><Text style={styles.textBtnLabel}>返回手输</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {!cameraError ? <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        onMountError={() => { locked.current = true; setScanned(true); setCameraError(true); setLocalError('相机启动失败，请重试或返回手输。'); }}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : ({ data }) => { void handleData(data); }}
      /> : null}
      <View style={styles.mask} pointerEvents="none">
        <View style={styles.maskBar} />
        <View style={styles.mid}>
          <View style={styles.maskSide} />
          <View style={[styles.frame, { width: box, height: box }]}>
            <View style={[styles.corner, styles.tl]} />
            <View style={[styles.corner, styles.tr]} />
            <View style={[styles.corner, styles.bl]} />
            <View style={[styles.corner, styles.br]} />
          </View>
          <View style={styles.maskSide} />
        </View>
        <View style={styles.maskBar} />
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭扫码，返回手输" style={styles.close} onPress={onClose} hitSlop={12}>
        <Text style={styles.closeX}>×</Text>
      </Pressable>
      <View style={styles.bottom}>
        <Text accessibilityLiveRegion="polite" style={styles.hint}>{busy ? '正在连接…' : localError || '对准主机台右边的出门二维码，不要扫左边'}</Text>
        {localError ? (
          <Pressable accessibilityRole="button" onPress={retry} style={styles.solidBtn}>
            <Text style={styles.solidLabel}>再扫一次</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  fallback: { flex: 1, backgroundColor: '#0b0d10', alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 },
  fallbackText: { color: '#fff', fontSize: 16 },
  mask: { ...StyleSheet.absoluteFillObject },
  maskBar: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  mid: { flexDirection: 'row', alignItems: 'center' },
  maskSide: { flex: 1, alignSelf: 'stretch', backgroundColor: 'rgba(0,0,0,0.55)' },
  frame: { backgroundColor: 'transparent' },
  corner: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderColor: '#fff',
  },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3 },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3 },
  close: {
    position: 'absolute',
    top: 18,
    left: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeX: { color: '#fff', fontSize: 26, lineHeight: 28, marginTop: -2 },
  bottom: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 48,
    alignItems: 'center',
    gap: 14,
  },
  hint: { color: '#fff', fontSize: 15, textAlign: 'center' },
  solidBtn: {
    minHeight: 44,
    minWidth: 140,
    paddingHorizontal: 20,
    borderRadius: 22,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  solidLabel: { color: '#111', fontSize: 15, fontWeight: '600' },
  textBtn: { paddingVertical: 8 },
  textBtnLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 15 },
});
