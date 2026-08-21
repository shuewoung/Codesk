import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { FilePanel } from './src/screens/FilePanel';
import { FilePreviewScreen } from './src/screens/FilePreviewScreen';
import { PairScreen } from './src/screens/PairScreen';
import { ScanScreen } from './src/screens/ScanScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { ThreadListScreen } from './src/screens/ThreadListScreen';
import { ThreadScreen } from './src/screens/ThreadScreen';
import { SessionProvider, useSession } from './src/session';
import { subscribeJpushOpens } from './src/push';
import { ThemeProvider, useTheme } from './src/theme-context';

type Shell =
  | { name: 'pair' }
  | { name: 'scan' }
  | { name: 'settings' }
  | { name: 'file'; path: string };

function Root() {
  const session = useSession();
  const { colors, theme } = useTheme();
  const [shell, setShell] = useState<Shell | null>(null);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [left, setLeft] = useState(false);
  const [right, setRight] = useState(false);

  const { width } = useWindowDimensions();
  const isWide = width >= 1100;

  useEffect(() => {
    if (!session.hydrated) return;
    if (!session.paired) {
      setShell((prev) => (prev?.name === 'scan' ? prev : { name: 'pair' }));
      return;
    }
    setShell((prev) => (prev?.name === 'pair' || prev?.name === 'scan' ? null : prev));
    if (!threadId && session.threads[0]) setThreadId(session.threads[0].id);
  }, [session.hydrated, session.paired, session.threads]);

  useEffect(() => {
    if (session.lastCreatedId) {
      setThreadId(session.lastCreatedId);
      if (!isWide) setLeft(false);
    }
  }, [session.lastCreatedId, isWide]);

  useEffect(() => subscribeJpushOpens((id) => {
    setThreadId(id);
    setShell((prev) => (prev?.name === 'pair' || prev?.name === 'scan' ? prev : null));
    setLeft(false);
    setRight(false);
  }), []);

  if (!session.hydrated) {
    return (
      <View style={[styles.boot, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.text} />
      </View>
    );
  }

  let body: React.ReactNode;
  if (shell?.name === 'pair') {
    body = <PairScreen onScan={() => setShell(Platform.OS === 'web' ? { name: 'pair' } : { name: 'scan' })} />;
  } else if (shell?.name === 'scan') {
    if (Platform.OS === 'web') {
      body = <PairScreen onScan={() => setShell({ name: 'pair' })} />;
    } else {
      return (
        <View style={styles.scanRoot}>
          <StatusBar style="light" />
          <ScanScreen onClose={() => setShell(session.paired ? null : { name: 'pair' })} />
        </View>
      );
    }
  } else if (shell?.name === 'settings') {
    body = (
      <SettingsScreen
        onBack={() => setShell(null)}
        onScan={() => setShell({ name: 'scan' })}
      />
    );
  } else if (shell?.name === 'file') {
    body = (
      <FilePreviewScreen
        threadId={threadId || ''}
        path={shell.path}
        onBack={() => setShell(null)}
      />
    );
  } else {
    const narrowLeft = left && !isWide;
    const narrowRight = right && !isWide;

    if (isWide) {
      body = (
        <View style={styles.desktopRow}>
          <View style={[styles.desktopLeft, { backgroundColor: colors.bg, borderRightColor: colors.line }]}>
            <ThreadListScreen
              selectedId={threadId}
              onOpenThread={setThreadId}
              onSettings={() => setShell({ name: 'settings' })}
              onScan={() => setShell({ name: 'scan' })}
            />
          </View>

          <View style={styles.desktopMain}>
            <ThreadScreen
              threadId={threadId}
              onOpenLeft={() => setLeft((v) => !v)}
              onOpenRight={() => setRight((v) => !v)}
              onOpenFile={(path) => setShell({ name: 'file', path })}
              onScan={() => setShell({ name: 'scan' })}
              hideSideButtons
            />
          </View>

          <View style={[styles.desktopRight, { backgroundColor: colors.bg, borderLeftColor: colors.line }]}>
            <FilePanel
              threadId={threadId}
              onOpenFile={(path) => setShell({ name: 'file', path })}
            />
          </View>
        </View>
      );
    } else {
      body = (
        <View style={styles.main}>
          <ThreadScreen
            threadId={threadId}
            onOpenLeft={() => { setRight(false); setLeft(true); }}
            onOpenRight={() => { setLeft(false); setRight(true); }}
            onOpenFile={(path) => { setRight(false); setShell({ name: 'file', path }); }}
            onScan={() => setShell({ name: 'scan' })}
          />
          {narrowLeft ? (
            <View style={styles.overlay}>
              <View style={[styles.drawerLeft, { backgroundColor: colors.bg }]}>
                <ThreadListScreen
                  selectedId={threadId}
                  onOpenThread={(id) => { setThreadId(id); setLeft(false); }}
                  onSettings={() => { setLeft(false); setShell({ name: 'settings' }); }}
                  onScan={() => { setLeft(false); setShell({ name: 'scan' }); }}
                />
              </View>
              <Pressable style={styles.dim} onPress={() => setLeft(false)} />
            </View>
          ) : null}
          {narrowRight ? (
            <View style={styles.overlay}>
              <Pressable style={styles.dim} onPress={() => setRight(false)} />
              <View style={[styles.drawerRight, { backgroundColor: colors.bg }]}>
                <FilePanel
                  threadId={threadId}
                  onOpenFile={(path) => { setRight(false); setShell({ name: 'file', path }); }}
                />
              </View>
            </View>
          ) : null}
        </View>
      );
    }
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]} edges={['top', 'left', 'right']}>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
      {body}
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <SessionProvider>
          <Root />
        </SessionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scanRoot: { flex: 1, backgroundColor: '#000' },
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFillObject, flexDirection: 'row' },
  dim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.28)' },
  drawerLeft: { width: '82%', maxWidth: 360 },
  drawerRight: { width: '82%', maxWidth: 360 },

  // Wide screen desktop layout (two sidebars always visible)
  desktopRow: { flex: 1, flexDirection: 'row' },
  desktopLeft: { width: 280, borderRightWidth: 1, overflow: 'hidden' },
  desktopMain: { flex: 1, minWidth: 0 },
  desktopRight: { width: 320, borderLeftWidth: 1, overflow: 'hidden' },
});
