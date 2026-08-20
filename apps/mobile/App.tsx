import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { FilePanel } from './src/screens/FilePanel';
import { FilePreviewScreen } from './src/screens/FilePreviewScreen';
import { PairScreen } from './src/screens/PairScreen';
import { ScanScreen } from './src/screens/ScanScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { ThreadListScreen } from './src/screens/ThreadListScreen';
import { ThreadScreen } from './src/screens/ThreadScreen';
import { SessionProvider, useSession } from './src/session';
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
      setLeft(false);
    }
  }, [session.lastCreatedId]);

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
    body = (
      <View style={styles.main}>
        <ThreadScreen
          threadId={threadId}
          onOpenLeft={() => { setRight(false); setLeft(true); }}
          onOpenRight={() => { setLeft(false); setRight(true); }}
          onOpenFile={(path) => { setRight(false); setShell({ name: 'file', path }); }}
          onScan={() => setShell({ name: 'scan' })}
        />
        {left ? (
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
        {right ? (
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
});
