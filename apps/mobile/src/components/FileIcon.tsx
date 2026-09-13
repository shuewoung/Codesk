import React from 'react';
import { Text, View } from 'react-native';

export type FileIconInfo = { text: string; color?: string; isBadge?: boolean };
export function getFileIconInfo(filename: string): FileIconInfo {
  const name = filename.split(/[\\/]/).pop()?.toLowerCase() || '';
  const ext = name.split('.').pop() || '';
  if (name.startsWith('readme')) return { text: 'MD', color: '#38bdf8', isBadge: true };
  const groups: [string[], string, string][] = [
    [['ts', 'tsx'], 'TS', '#3b82f6'], [['js', 'jsx', 'mjs', 'cjs'], 'JS', '#ca8a04'],
    [['md', 'markdown', 'mdx'], 'MD', '#0284c7'], [['json', 'jsonc', 'json5'], '{}', '#d97706'],
    [['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'heic'], 'IMG', '#a855f7'],
    [['pdf'], 'PDF', '#ef4444'], [['doc', 'docx', 'odt', 'rtf'], 'DOC', '#2563eb'],
    [['xls', 'xlsx', 'csv', 'tsv', 'ods'], 'XLS', '#16a34a'], [['ppt', 'pptx', 'odp'], 'PPT', '#ea580c'],
    [['zip', 'tar', 'gz', '7z', 'rar', 'bz2', 'xz'], 'ZIP', '#d97706'],
    [['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac'], 'AUD', '#9333ea'], [['mp4', 'mov', 'webm', 'avi', 'mkv'], 'VID', '#db2777'],
    [['html', 'htm', 'css', 'scss', 'vue', 'svelte'], 'WEB', '#ea580c'],
    [['py', 'ipynb'], 'PY', '#0284c7'], [['go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h'], 'CODE', '#0891b2'],
    [['sh', 'bash', 'ps1', 'bat', 'cmd'], 'CLI', '#16a34a'],
    [['yaml', 'yml', 'toml', 'ini', 'env', 'conf', 'gitignore'], 'CFG', '#64748b'],
    [['db', 'sqlite', 'sql'], 'DB', '#0284c7'],
  ];
  for (const [extensions, text, color] of groups) if (extensions.includes(ext)) return { text, color, isBadge: true };
  return { text: 'FILE', color: '#64748b', isBadge: true };
}

export function FileIcon({ name, size = 22, isDirectory = false }: { name: string; size?: number; isDirectory?: boolean }) {
  const icon = isDirectory ? { text: 'DIR', color: '#ca8a04' } : getFileIconInfo(name);
  return <View accessibilityLabel={isDirectory ? '目录' : `${icon.text} 文件`} style={{ width: size, height: size, borderRadius: 4, borderWidth: 1, borderColor: icon.color, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
    <Text style={{ color: icon.color, fontSize: Math.max(7, size * 0.31), fontWeight: '800' }}>{icon.text}</Text>
  </View>;
}

export function formatFileSize(size?: number): string {
  if (size == null || !Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}
