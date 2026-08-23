import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
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
import { readBrowserThreadId, syncBrowserThreadId } from './src/thread-route';

type Shell =
  | { name: 'pair' }
  | { name: 'scan' }
  | { name: 'settings' }
  | { name: 'file'; path: string };

function Root() {
  const session = useSession();
  const { colors, theme } = useTheme();
  const [shell, setShell] = useState<Shell | null>(null);
  const pendingUrlRef = useRef(Platform.OS === 'web' ? readBrowserThreadId() : '');
  const [holdUrlThread, setHoldUrlThread] = useState(() => Boolean(pendingUrlRef.current));
  const [threadId, setThreadId] = useState<string | undefined>();
  const [left, setLeft] = useState(false);
  const [right, setRight] = useState(false);

  const { width } = useWindowDimensions();
  const isWide = width >= 1100;

  const selectThread = useCallback((id: string) => {
    pendingUrlRef.current = '';
    setHoldUrlThread(false);
    setThreadId(id);
  }, []);

  useEffect(() => {
    if (!session.hydrated) return;
    if (!session.paired) {
      setShell((prev) => (prev?.name === 'scan' ? prev : { name: 'pair' }));
      return;
    }
    setShell((prev) => (prev?.name === 'pair' || prev?.name === 'scan' ? null : prev));
    const pending = pendingUrlRef.current;
    if (pending) {
      if (session.conn !== 'connected') {
        setHoldUrlThread(true);
        if (threadId !== undefined) setThreadId(undefined);
        return;
      }
      if (threadId !== pending) {
        setThreadId(pending);
        return;
      }
      pendingUrlRef.current = '';
      setHoldUrlThread(false);
      return;
    }
    if (isWide && !threadId && session.threads[0]) setThreadId(session.threads[0].id);
  }, [session.hydrated, session.paired, session.threads, session.conn, threadId, isWide]);

  useEffect(() => {
    if (pendingUrlRef.current) return;
    if (session.lastCreatedId) {
      selectThread(session.lastCreatedId);
      if (!isWide) setLeft(false);
    }
  }, [session.lastCreatedId, isWide, selectThread]);

  useEffect(() => subscribeJpushOpens((id) => {
    selectThread(id);
    setShell((prev) => (prev?.name === 'pair' || prev?.name === 'scan' ? prev : null));
    setLeft(false);
    setRight(false);
  }), [selectThread]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onUrl = () => {
      const id = readBrowserThreadId();
      if (!id) return;
      if (session.paired && session.conn === 'connected') {
        selectThread(id);
        return;
      }
      pendingUrlRef.current = id;
      setHoldUrlThread(true);
      setThreadId(undefined);
    };
    window.addEventListener('hashchange', onUrl);
    window.addEventListener('popstate', onUrl);
    return () => {
      window.removeEventListener('hashchange', onUrl);
      window.removeEventListener('popstate', onUrl);
    };
  }, [session.paired, session.conn, selectThread]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (holdUrlThread || !threadId) return;
    syncBrowserThreadId(threadId);
  }, [threadId, holdUrlThread]);

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
  } else if (shell?.name === 'file' && !isWide) {
    body = (
      <FilePreviewScreen
        threadId={threadId || ''}
        path={shell.path}
        onBack={() => setShell(null)}
      />
    );
  } else {
    const narrowRight = right && !isWide;
    const waitingThread = holdUrlThread && !threadId;
    const waitingPane = (
      <View style={styles.boot}>
        <ActivityIndicator color={colors.text} />
        <Text style={{ marginTop: 12, color: colors.muted, fontSize: 13 }}>连接后打开会话</Text>
      </View>
    );

    if (isWide) {
      body = (
        <View style={styles.desktopRow}>
          <View style={[styles.desktopLeft, { backgroundColor: colors.shell, borderRightColor: colors.line }]}>
            <ThreadListScreen
              selectedId={threadId}
              onOpenThread={selectThread}
              onSettings={() => setShell({ name: 'settings' })}
              onScan={() => setShell({ name: 'scan' })}
            />
          </View>

          <View style={styles.desktopMain}>
            {waitingThread ? waitingPane : (
              <ThreadScreen
                threadId={threadId}
                onOpenLeft={() => setLeft((v) => !v)}
                onOpenRight={() => setRight((v) => !v)}
                onOpenFile={(path) => setShell({ name: 'file', path })}
                onOpenThread={selectThread}
                onScan={() => setShell({ name: 'scan' })}
                hideSideButtons
              />
            )}
          </View>

          <View style={[styles.desktopRight, { backgroundColor: colors.shell, borderLeftColor: colors.line }]}>
            <FilePanel
              threadId={waitingThread ? undefined : threadId}
              onOpenFile={(path) => setShell({ name: 'file', path })}
              onOpenThread={selectThread}
            />
          </View>
        </View>
      );
    } else if (!threadId || waitingThread) {
      body = (
        <View style={styles.main}>
          <ThreadListScreen
            selectedId={undefined}
            onOpenThread={(id) => { selectThread(id); setLeft(false); }}
            onSettings={() => setShell({ name: 'settings' })}
            onScan={() => setShell({ name: 'scan' })}
          />
        </View>
      );
    } else {
      body = (
        <View style={styles.main}>
          <ThreadScreen
            threadId={threadId}
            onBack={() => setThreadId(undefined)}
            onOpenLeft={() => { setRight(false); setLeft(true); }}
            onOpenRight={() => { setLeft(false); setRight(true); }}
            onOpenFile={(path) => { setRight(false); setShell({ name: 'file', path }); }}
            onOpenThread={selectThread}
            onScan={() => setShell({ name: 'scan' })}
          />
          {narrowRight ? (
            <View style={styles.overlay}>
              <Pressable style={styles.dim} onPress={() => setRight(false)} />
              <View style={[styles.drawerRight, { backgroundColor: colors.shell }]}>
                <FilePanel
                  threadId={threadId}
                  onOpenFile={(path) => { setRight(false); setShell({ name: 'file', path }); }}
                  onOpenThread={(id) => { setRight(false); selectThread(id); }}
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
      {isWide && shell?.name === 'file' ? (
        <View style={styles.previewOverlay}>
          <Pressable style={styles.dim} onPress={() => setShell(null)} />
          <View style={[styles.previewCard, { backgroundColor: colors.bg, borderColor: colors.line }]}>
            <FilePreviewScreen
              threadId={threadId || ''}
              path={shell.path}
              onBack={() => setShell(null)}
            />
          </View>
        </View>
      ) : null}
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
  previewOverlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  previewCard: {
    width: '58%',
    maxWidth: 920,
    borderLeftWidth: 1,
    overflow: 'hidden',
  },
});
