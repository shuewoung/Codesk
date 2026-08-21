import React, { useEffect, useMemo, useState } from 'react';
import {
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Markdown from 'react-native-markdown-display';
import { useSession } from '../session';
import { radius, space } from '../theme';
import { useTheme } from '../theme-context';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg']);

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'from', 'default',
  'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue',
  'class', 'extends', 'new', 'this', 'super', 'typeof', 'instanceof', 'void',
  'async', 'await', 'try', 'catch', 'finally', 'throw', 'yield',
  'interface', 'type', 'enum', 'implements', 'public', 'private', 'protected', 'readonly',
  'def', 'elif', 'print', 'self', 'lambda', 'with', 'as', 'pass', 'None', 'True', 'False',
  'select', 'from', 'where', 'insert', 'update', 'delete', 'create', 'table',
]);

type Token = { text: string; type: 'plain' | 'keyword' | 'string' | 'number' | 'comment' | 'operator' };
type CodeLine = { lineNum: number; tokens: Token[] };

export function tokenizeCode(code: string, ext: string): CodeLine[] {
  let content = code;
  const isJson = /\.(json|json5|jsonc)$/i.test(ext);
  if (isJson) {
    try {
      content = JSON.stringify(JSON.parse(code), null, 2);
    } catch {
      // fall back to raw
    }
  }

  const rawLines = content.split('\n');
  const isJsLike = /\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(ext);
  const isPy = /\.(py|pyw)$/i.test(ext);

  return rawLines.map((lineStr, idx) => {
    if (!lineStr) {
      return { lineNum: idx + 1, tokens: [{ text: ' ', type: 'plain' }] };
    }

    const trimmed = lineStr.trim();
    if ((isJsLike && trimmed.startsWith('//')) || (isPy && trimmed.startsWith('#'))) {
      return { lineNum: idx + 1, tokens: [{ text: lineStr, type: 'comment' }] };
    }

    const tokens: Token[] = [];
    const regex = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/.*|#.*|\b\d+(?:\.\d+)?\b|\b[a-zA-Z_$][a-zA-Z0-9_$]*\b|[{}()[\].,;:+\-*/%=<>!&|^~?]+|\s+|[^\s\w]+)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(lineStr)) !== null) {
      const txt = match[0];
      if (txt.startsWith('//') || txt.startsWith('#')) {
        tokens.push({ text: txt, type: 'comment' });
      } else if (txt.startsWith('"') || txt.startsWith("'") || txt.startsWith('`')) {
        tokens.push({ text: txt, type: 'string' });
      } else if (/^\d+(?:\.\d+)?$/.test(txt)) {
        tokens.push({ text: txt, type: 'number' });
      } else if (KEYWORDS.has(txt)) {
        tokens.push({ text: txt, type: 'keyword' });
      } else if (/^[{}()[\].,;:+\-*/%=<>!&|^~?]+$/.test(txt)) {
        tokens.push({ text: txt, type: 'operator' });
      } else {
        tokens.push({ text: txt, type: 'plain' });
      }
    }

    if (!tokens.length) {
      tokens.push({ text: lineStr, type: 'plain' });
    }

    return { lineNum: idx + 1, tokens };
  });
}

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
  const { colors, theme } = useTheme();
  const isDark = theme === 'dark';
  const file = session.files[path];
  const [htmlViewMode, setHtmlViewMode] = useState<'preview' | 'code'>('preview');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    session.requestFile(threadId, path);
  }, [threadId, path]);

  const ext = file?.ext?.toLowerCase() || '';
  const isImage = file && file.encoding === 'base64' && IMAGE_EXTS.has(ext);
  const isMarkdown = file && file.encoding === 'utf8' && ['.md', '.markdown', '.mdx'].includes(ext);
  const isHtml = file && file.encoding === 'utf8' && ['.html', '.htm'].includes(ext);

  const tokenizedLines = useMemo(() => {
    if (!file || !file.content || isImage || isMarkdown) return [];
    return tokenizeCode(file.content, ext);
  }, [file?.content, ext, isImage, isMarkdown]);

  const handleCopy = async () => {
    if (!file?.content) return;
    await Clipboard.setStringAsync(file.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const tokenColors = {
    keyword: isDark ? '#c084fc' : '#7c3aed',
    string: isDark ? '#4ade80' : '#15803d',
    number: isDark ? '#fbbf24' : '#b45309',
    comment: isDark ? '#94a3b8' : '#64748b',
    operator: isDark ? '#94a3b8' : '#64748b',
    plain: colors.text,
  };

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      {/* Top Navigation Bar */}
      <View style={[styles.header, { borderBottomColor: colors.line }]}>
        <Pressable onPress={onBack} hitSlop={10} style={styles.backBtn}>
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>‹ 返回</Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {file?.fileName || path}
        </Text>
        <Pressable onPress={handleCopy} hitSlop={10} style={styles.copyBtn}>
          <Text style={{ color: copied ? colors.ok : colors.muted, fontSize: 13, fontWeight: '600' }}>
            {copied ? '✓ 已复制' : '复制'}
          </Text>
        </Pressable>
      </View>

      {/* HTML Mode Switcher Bar */}
      {isHtml ? (
        <View style={[styles.subBar, { borderBottomColor: colors.line, backgroundColor: colors.shell }]}>
          <View style={styles.tabGroup}>
            <Pressable
              onPress={() => setHtmlViewMode('preview')}
              style={[styles.tabBtn, htmlViewMode === 'preview' && { backgroundColor: colors.bg }]}
            >
              <Text style={{ color: colors.text, fontSize: 12, fontWeight: htmlViewMode === 'preview' ? '700' : '400' }}>
                🌐 网页预览
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setHtmlViewMode('code')}
              style={[styles.tabBtn, htmlViewMode === 'code' && { backgroundColor: colors.bg }]}
            >
              <Text style={{ color: colors.text, fontSize: 12, fontWeight: htmlViewMode === 'code' ? '700' : '400' }}>
                💻 源码高亮
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Content Viewer Body */}
      {!file ? (
        <View style={styles.centerBox}>
          <Text style={[styles.hint, { color: colors.muted }]}>⚡ 正在读取文件...</Text>
        </View>
      ) : file.error ? (
        <View style={styles.centerBox}>
          <Text style={[styles.hint, { color: colors.danger }]}>❌ {file.error}</Text>
        </View>
      ) : isImage ? (
        <ScrollView contentContainerStyle={styles.imageBody}>
          <Image
            source={{ uri: `data:image/${ext.replace('.', '')};base64,${file.content}` }}
            style={styles.image}
            resizeMode="contain"
          />
          {file.truncated ? <Text style={[styles.truncatedNote, { color: colors.warn }]}>⚠️ 内容已截断</Text> : null}
        </ScrollView>
      ) : isMarkdown ? (
        <ScrollView contentContainerStyle={styles.markdownBody}>
          <Markdown
            style={{
              body: { color: colors.text, fontSize: 15, lineHeight: 22 },
              heading1: { color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 12, marginBottom: 6 },
              heading2: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 10, marginBottom: 4 },
              heading3: { color: colors.text, fontSize: 16, fontWeight: '600', marginTop: 8, marginBottom: 4 },
              paragraph: { color: colors.text, marginBottom: 8 },
              strong: { color: colors.text, fontWeight: '700' },
              em: { color: colors.text, fontStyle: 'italic' },
              link: { color: colors.text, fontWeight: '700', textDecorationLine: 'underline' },
              code_inline: {
                color: colors.text,
                fontWeight: '700',
                backgroundColor: 'transparent',
                borderWidth: 0,
                padding: 0,
              },
              fence: {
                backgroundColor: colors.shell,
                color: colors.text,
                borderWidth: 0,
                borderRadius: 8,
                padding: 10,
                fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                fontSize: 13,
                marginVertical: 6,
              },
              table: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, marginVertical: 6 },
              th: { backgroundColor: colors.shell, padding: 6, fontWeight: '700' },
              td: { padding: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
            }}
          >
            {file.content || ''}
          </Markdown>
          {file.truncated ? <Text style={[styles.truncatedNote, { color: colors.warn }]}>⚠️ 内容已截断</Text> : null}
        </ScrollView>
      ) : (
        /* Code & Text Highlighting Engine with Line Numbers */
        <ScrollView style={styles.codeContainer} contentContainerStyle={styles.codeScrollContent}>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View style={styles.codeTable}>
              {tokenizedLines.map((row) => (
                <View key={row.lineNum} style={styles.codeRow}>
                  {/* Line Number Column */}
                  <Text style={[styles.lineNum, { color: colors.muted }]}>
                    {row.lineNum}
                  </Text>
                  {/* Code Line Tokens */}
                  <Text style={styles.codeLineText} selectable>
                    {row.tokens.map((tok, tIdx) => (
                      <Text
                        key={tIdx}
                        style={{
                          color: tokenColors[tok.type] || colors.text,
                          fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                          fontSize: 13,
                          lineHeight: 20,
                        }}
                      >
                        {tok.text}
                      </Text>
                    ))}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
          {file.truncated ? <Text style={[styles.truncatedNote, { color: colors.warn }]}>⚠️ 内容已截断</Text> : null}
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
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { paddingVertical: 4, paddingRight: 8 },
  title: { flex: 1, textAlign: 'center', fontSize: 15, fontWeight: '600', marginHorizontal: 8 },
  copyBtn: { paddingVertical: 4, paddingLeft: 8 },
  subBar: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  tabGroup: {
    flexDirection: 'row',
    backgroundColor: 'rgba(0, 0, 0, 0.06)',
    borderRadius: 8,
    padding: 2,
    gap: 4,
  },
  tabBtn: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 6,
  },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg },
  hint: { fontSize: 15 },
  imageBody: { padding: space.md, alignItems: 'center' },
  image: { width: '100%', height: 400 },
  markdownBody: { padding: space.md },
  webFrameContainer: { flex: 1, width: '100%', height: '100%' },
  codeContainer: { flex: 1 },
  codeScrollContent: { paddingVertical: 8, paddingRight: 16 },
  codeTable: { flexDirection: 'column' },
  codeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 1,
  },
  lineNum: {
    width: 44,
    textAlign: 'right',
    paddingRight: 12,
    fontSize: 12,
    lineHeight: 20,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    userSelect: 'none',
  },
  codeLineText: {
    fontSize: 13,
    lineHeight: 20,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  truncatedNote: { padding: 12, fontSize: 13, fontWeight: '600' },
});
