import React, { useEffect } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useSession } from '../session';
import { space } from '../theme';
import { useTheme } from '../theme-context';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export function FilePreviewScreen({
  threadId,
  path,
  onBack,
}: {
  threadId: string;
  path: string;
  onBack: () => void;
}) {
  const session = useSession();
  const { colors } = useTheme();
  const file = session.files[path];

  useEffect(() => {
    session.requestFile(threadId, path);
  }, [threadId, path]);

  const isImage = file && file.encoding === 'base64' && IMAGE_EXTS.has(file.ext);
  const isMarkdown = file && file.encoding === 'utf8' && ['.md', '.markdown', '.mdx'].includes(file.ext);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { borderBottomColor: colors.line }]}>
        <Pressable onPress={onBack}>
          <Text style={{ color: colors.text, fontSize: 16 }}>返回</Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {file?.fileName || path}
        </Text>
        <View style={{ width: 40 }} />
      </View>
      {!file ? (
        <Text style={[styles.hint, { color: colors.muted }]}>正在读取…</Text>
      ) : file.error ? (
        <Text style={[styles.hint, { color: colors.danger }]}>{file.error}</Text>
      ) : isImage ? (
        <ScrollView contentContainerStyle={styles.body}>
          <Image
            source={{ uri: `data:image/${file.ext.replace('.', '')};base64,${file.content}` }}
            style={styles.image}
            resizeMode="contain"
          />
          {file.truncated ? <Text style={{ color: colors.warn }}>内容已截断</Text> : null}
        </ScrollView>
      ) : isMarkdown ? (
        <ScrollView contentContainerStyle={styles.body}>
          <Markdown
            style={{
              body: { color: colors.text, fontSize: 16, lineHeight: 24 },
              heading1: { color: colors.text, fontSize: 22, fontWeight: '700' },
              heading2: { color: colors.text, fontSize: 19, fontWeight: '700' },
              code_inline: { backgroundColor: colors.card, color: colors.text },
              fence: { backgroundColor: colors.shell, color: colors.text },
              link: { color: colors.ok },
            }}
          >
            {file.content || ''}
          </Markdown>
          {file.truncated ? <Text style={{ color: colors.warn }}>内容已截断</Text> : null}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <Text selectable style={{ color: colors.text, fontSize: 13, lineHeight: 20 }}>
            {file.content || '（空文件）'}
          </Text>
          {file.truncated ? <Text style={{ color: colors.warn, marginTop: 12 }}>内容已截断</Text> : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '600', marginHorizontal: 8 },
  hint: { padding: space.lg, fontSize: 15 },
  body: { padding: space.md },
  image: { width: '100%', height: 360 },
});
