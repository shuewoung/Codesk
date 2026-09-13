import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { downloadOriginal, downloadOriginalHttp } from '../download';
import { FileIcon } from '../components/FileIcon';
import { useHistories, useSession, useWorkspace } from '../session';
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
import { space } from '../theme';
import { useTheme } from '../theme-context';
import { triggerHaptic } from '../utils/haptics';
import { hubRawFileUrl, isAbsFilePath, lookupCachedFile } from '../utils/localFileUrl';

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
  const workspace = useWorkspace();
  const session = useSession();
  const { colors, theme } = useTheme();
  const isDark = theme === 'dark';
  const file = lookupCachedFile(workspace.files, path);
  const [htmlViewMode, setHtmlViewMode] = useState<'preview' | 'code'>(Platform.OS === 'web' ? 'preview' : 'code');
  const [copiedContent, setCopiedContent] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [retry, setRetry] = useState(0);
  const [previewError, setPreviewError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState('');
  const controller = useRef<AbortController | null>(null);
  const { histories } = useHistories();
  const cwd = histories[threadId]?.cwd || session.threads.find(t => t.id === threadId)?.cwd || '';
  useEffect(() => { setZoom(1); setPreviewError(''); setDownloadStatus(''); return () => controller.current?.abort(); }, [path, threadId, session.connectionIdentity]);
  useEffect(() => { if (session.conn !== 'connected') controller.current?.abort(); }, [session.conn]);
  const retryPreview = () => { setPreviewError(''); setRetry(n => n + 1); };
  const handleDownload = async () => {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setDownloading(true);
    setDownloadStatus('正在下载原件…');
    const digest = async (bytes: Uint8Array) => {
      const hash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as unknown as BufferSource);
      return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
    };
    try {
      const requestedPath = file?.path || path;
      const options = { digest, signal: abort.signal, fileName: file?.fileName || pathBase };
      const result = sameOriginRaw
        ? await downloadOriginalHttp(`/api/file?${new URLSearchParams({ threadId, path: requestedPath, cwd, download: 'original' })}`, options)
        : await downloadOriginal({ sendMessage: session.sendApp, subscribeMessages: session.subscribeApp }, {
          threadId, path: requestedPath, cwd, ...options,
          onProgress: (received, total) => setDownloadStatus(`下载原件 ${total ? Math.round(received / total * 100) : 100}%`),
        });
      if (abort.signal.aborted) return;
      const safeName = result.fileName.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_') || 'download';
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([result.bytes as unknown as BlobPart], { type: 'application/octet-stream' }));
        const link = document.createElement('a'); link.href = url; link.download = safeName;
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        setDownloadStatus('原件已校验，已交给浏览器保存');
      } else {
        if (!await Sharing.isAvailableAsync()) throw new Error('此设备不支持系统分享');
        const cached = new File(Paths.cache, `original-${Date.now()}`, safeName);
        cached.create({ intermediates: true, overwrite: true });
        cached.write(result.bytes);
        try { await Sharing.shareAsync(cached.uri, { dialogTitle: '保存或分享原件' }); }
        finally { try { cached.delete(); } catch { /* system cache cleanup */ } }
        setDownloadStatus('原件已校验，已打开系统分享');
      }
    } catch (error) {
      if (!abort.signal.aborted) setDownloadStatus(error instanceof Error ? error.message : '原件下载失败，请重试');
    } finally {
      if (controller.current === abort) { controller.current = null; setDownloading(false); }
    }
  };

  const requestFile = workspace.requestFile;
  useEffect(() => {
    requestFile(threadId, path);
  }, [threadId, path, requestFile, retry]);

  const pathBase = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const pathExt = pathBase.includes('.') ? pathBase.slice(pathBase.lastIndexOf('.')).toLowerCase() : '';
  const ext = (file?.ext || pathExt).toLowerCase();
  const isImage = file && file.encoding === 'base64' && IMAGE_EXTS.has(ext);
  const isMarkdown = file && file.encoding === 'utf8' && ['.md', '.markdown', '.mdx'].includes(ext);
  const isHtml = ['.html', '.htm'].includes(ext);
  const isOffice = ['.docx', '.xlsx', '.pptx', '.pdf', '.doc', '.xls', '.ppt'].includes(ext);
  const isCsv = file && file.encoding === 'utf8' && ['.csv', '.tsv'].includes(ext);
  const looksLikeDir = isAbsFilePath(path) && !/\.[a-z0-9]{1,8}$/i.test(path.replace(/[\\/]+$/, ''));
  const sameOriginRaw = Platform.OS === 'web' && session.mode === 'lan' && (() => { try { return new URL(session.lanUrl, window.location.origin).origin === window.location.origin; } catch { return false; } })();
  const previewRequest = session.requestState('get_file', threadId, path);
  const loadError = previewError || (previewRequest?.status === 'error' || previewRequest?.status === 'timeout' ? previewRequest.error || '预览加载失败，请重试' : '');
  const webBrowserView = sameOriginRaw && (isOffice || isHtml || looksLikeDir);
  const rawFileUrl = `${hubRawFileUrl(file?.path || path)}&${new URLSearchParams({ threadId, cwd })}`;

  const tokenizedLines = useMemo(() => {
    if (!file || !file.content || isImage || isMarkdown) return [];
    return tokenizeCode(file.content, ext);
  }, [file, ext, isImage, isMarkdown]);

  const handleCopy = async () => {
    if (!file?.content) return;
    triggerHaptic('light');
    await Clipboard.setStringAsync(file.content);
    setCopiedContent(true);
    setTimeout(() => setCopiedContent(false), 2000);
  };

  const handleCopyPath = async () => {
    triggerHaptic('light');
    await Clipboard.setStringAsync(file?.path || path);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 1600);
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
        <Pressable
          onPress={() => {
            triggerHaptic('light');
            onBack();
          }}
          hitSlop={10}
          style={styles.backBtn}
        >
          <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>‹ 返回</Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {file?.fileName || path}
        </Text>
        <Pressable onPress={handleCopyPath} hitSlop={10} style={styles.copyBtn}>
          <Text style={{ color: copiedPath ? colors.ok : colors.muted, fontSize: 13, fontWeight: '600' }}>
            {copiedPath ? '✓ 路径' : '路径'}
          </Text>
        </Pressable>
        <Pressable onPress={handleCopy} hitSlop={10} style={styles.copyBtn}>
          <Text style={{ color: copiedContent ? colors.ok : colors.muted, fontSize: 13, fontWeight: '600' }}>
            {copiedContent ? '✓ 已复制' : '复制'}
          </Text>
        </Pressable>
      </View>

      <View style={{ padding: 10, gap: 6, borderBottomWidth: 1, borderColor: colors.line }}>
        <View style={{ flexDirection: 'row', gap: 8 }}><FileIcon name={file?.fileName || path} /><Text selectable numberOfLines={2} style={{ flex: 1, color: colors.muted, fontSize: 11 }}>{file?.path || path}</Text></View>
        <Text style={{ color: colors.muted, fontSize: 11 }}>{ext.slice(1).toUpperCase() || '文件'}{file?.truncated ? ' · 预览已截断，下载始终使用完整原件' : ''}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
          <Pressable disabled={downloading} onPress={() => { void handleDownload(); }}><Text style={{ color: colors.text, fontWeight: '700' }}>{downloading ? '下载中…' : '下载原件'}</Text></Pressable>
          {downloading ? <Pressable onPress={() => { controller.current?.abort(); setDownloadStatus('下载已取消'); }}><Text style={{ color: colors.muted }}>取消</Text></Pressable> : null}
          <Pressable onPress={retryPreview}><Text style={{ color: colors.text }}>重新加载预览</Text></Pressable>
        </View>
        {downloadStatus ? <Text accessibilityLiveRegion="polite" style={{ color: colors.muted, fontSize: 12 }}>{downloadStatus}</Text> : null}
      </View>
      {/* HTML Mode Switcher Bar */}
      {isHtml && !webBrowserView ? (
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
      {(file?.error || (!file && loadError)) ? (
        <View style={styles.centerBox}>
          <Text style={{ color: colors.danger }}>{file?.error || loadError}</Text>
          <Pressable onPress={retryPreview} style={{ padding: 14 }}><Text style={{ color: colors.text }}>重试加载</Text></Pressable>
        </View>
      ) : webBrowserView ? (
        <View style={styles.webFrameContainer}>
          <iframe
            key={retry}
            sandbox="allow-scripts"
            src={rawFileUrl}
            title={file?.fileName || path}
            style={{ flex: 1, width: '100%', height: '100%', borderWidth: 0, backgroundColor: '#fff' }}
          />
        </View>
      ) : !file ? (
        <View style={styles.centerBox}>
          <Text style={[styles.hint, { color: colors.muted }]}>⚡ 正在读取文件...</Text>
        </View>
      ) : file.error ? (
        <View style={styles.centerBox}>
          <Text style={[styles.hint, { color: colors.danger }]}>❌ {file.error}</Text>
        </View>
      ) : isOffice ? (
        <View style={styles.centerBox}>
          <Text style={[styles.hint, { color: colors.text, fontWeight: '700' }]}>Office / PDF 产物</Text>
          <Text style={[styles.hint, { color: colors.muted, marginTop: 8 }]}>下载完整原件后，可通过系统分享在兼容应用中打开。</Text>
          <Pressable onPress={() => { void handleCopyPath(); }} style={{ marginTop: 12 }}>
            <Text style={{ color: colors.text, fontWeight: '700' }}>{copiedPath ? '已复制路径' : '复制路径'}</Text>
          </Pressable>
        </View>
      ) : isCsv ? (
        <ScrollView contentContainerStyle={styles.markdownBody}>
          <Text selectable style={{ color: colors.text, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, lineHeight: 18 }}>
            {file.content}
          </Text>
        </ScrollView>
      ) : isImage ? (
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 24, padding: 10 }}>
            <Pressable accessibilityLabel="缩小图片" onPress={() => setZoom(z => Math.max(0.5, z - 0.5))}><Text style={{ color: colors.text }}>缩小</Text></Pressable>
            <Pressable onPress={() => setZoom(1)}><Text style={{ color: colors.text }}>{Math.round(zoom * 100)}% 重置</Text></Pressable>
            <Pressable accessibilityLabel="放大图片" onPress={() => setZoom(z => Math.min(4, z + 0.5))}><Text style={{ color: colors.text }}>放大</Text></Pressable>
          </View>
          {previewError && !previewError.includes('超时') ? <Text style={{ color: colors.danger }}>{previewError}</Text> : null}
          <ScrollView minimumZoomScale={0.5} maximumZoomScale={4} contentContainerStyle={styles.imageBody}>
          <ScrollView horizontal contentContainerStyle={{ minWidth: '100%' }}>
          <Image
            key={retry}
            onError={() => setPreviewError('图片预览无法解码，请重试或下载原件')}
            onLoad={() => setPreviewError('')}
            source={{ uri: `data:image/${ext === '.svg' ? 'svg+xml' : ext === '.jpg' ? 'jpeg' : ext.replace('.', '')};base64,${file.content}` }}
            style={{ width: 360 * zoom, height: 400 * zoom }}
            resizeMode="contain"
          />
          </ScrollView>
          {file.truncated ? (
            <Pressable onPress={() => { void handleCopyPath(); }}>
              <Text style={[styles.truncatedNote, { color: colors.warn }]}>
                内容已截断。点这里复制完整路径，到电脑打开。
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
        </View>
      ) : isMarkdown ? (
        <ScrollView contentContainerStyle={styles.markdownBody}>
          <Markdown
            rules={{
              table: (markdownNode: any, children: any) => (
                <ScrollView
                  key={markdownNode.key}
                  horizontal
                  showsHorizontalScrollIndicator={true}
                  style={{ marginVertical: 6 }}
                  contentContainerStyle={{ minWidth: '100%' }}
                >
                  <View style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 6, overflow: 'hidden' }}>
                    {children}
                  </View>
                </ScrollView>
              ),
              tr: (markdownNode: any, children: any) => (
                <View
                  key={markdownNode.key}
                  style={{ flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }}
                >
                  {children}
                </View>
              ),
              th: (markdownNode: any, children: any) => (
                <View
                  key={markdownNode.key}
                  style={{ minWidth: 70, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: colors.shell }}
                >
                  <Text style={{ fontWeight: '600', color: colors.text, fontSize: 13 }}>{children}</Text>
                </View>
              ),
              td: (markdownNode: any, children: any) => (
                <View
                  key={markdownNode.key}
                  style={{ minWidth: 70, paddingHorizontal: 8, paddingVertical: 6 }}
                >
                  <Text style={{ color: colors.text, fontSize: 13 }}>{children}</Text>
                </View>
              ),
            }}
            style={{
              body: { color: colors.text, fontSize: 15, lineHeight: 22 },
              heading1: { color: colors.text, fontSize: 20, fontWeight: '600', marginTop: 12, marginBottom: 6 },
              heading2: { color: colors.text, fontSize: 18, fontWeight: '600', marginTop: 10, marginBottom: 4 },
              heading3: { color: colors.text, fontSize: 16, fontWeight: '600', marginTop: 8, marginBottom: 4 },
              paragraph: { color: colors.text, marginBottom: 8 },
              strong: { color: colors.text, fontWeight: '600' },
              em: { color: colors.text, fontStyle: 'italic' },
              link: { color: colors.text, fontWeight: '600', textDecorationLine: 'underline' },
              code_inline: {
                color: colors.text,
                fontWeight: '500',
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
            }}
          >
            {file.content || ''}
          </Markdown>
          {file.truncated ? (
            <Pressable onPress={() => { void handleCopyPath(); }}>
              <Text style={[styles.truncatedNote, { color: colors.warn }]}>
                内容已截断。点这里复制完整路径，到电脑打开。
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      ) : isHtml && htmlViewMode === 'preview' ? (
        Platform.OS === 'web' ? (
          <iframe
            srcDoc={file.content}
            sandbox="allow-scripts"
            style={{ flex: 1, width: '100%', borderWidth: 0, backgroundColor: '#fff' }}
          />
        ) : (
          <View style={styles.centerBox}>
            <Text style={[styles.hint, { color: colors.muted }]}>手机上看源码；电脑浏览器可实时预览 HTML。</Text>
          </View>
        )
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
          {file.truncated ? (
            <Pressable onPress={() => { void handleCopyPath(); }}>
              <Text style={[styles.truncatedNote, { color: colors.warn }]}>
                内容已截断。点这里复制完整路径，到电脑打开。
              </Text>
            </Pressable>
          ) : null}
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
