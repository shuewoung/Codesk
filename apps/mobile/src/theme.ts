export type ThemeName = 'light' | 'dark';

export type Palette = {
  name: ThemeName;
  bg: string;
  shell: string;
  card: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  danger: string;
  ok: string;
  warn: string;
  user: string;
  assistant: string;
  system: string;
  send: string;
  sendText: string;
};

export const light: Palette = {
  name: 'light',
  bg: '#ffffff',
  shell: '#f7f8fa',
  card: '#ebeef2',
  line: '#e5e7eb',
  text: '#1f242e',
  muted: '#71717a',
  accent: '#1f242e',
  danger: '#c43d3d',
  ok: '#3d9a5f',
  warn: '#b8860b',
  user: '#f4f4f4',
  assistant: '#ffffff',
  system: '#f7f8fa',
  send: '#1f242e',
  sendText: '#ffffff',
};

export const dark: Palette = {
  name: 'dark',
  bg: '#212121',
  shell: '#18181b',
  card: '#27272a',
  line: '#333336',
  text: '#ececec',
  muted: '#9a9a9a',
  accent: '#ffffff',
  danger: '#f07178',
  ok: '#7fd99a',
  warn: '#e6b450',
  user: '#2f2f2f',
  assistant: '#212121',
  system: '#18181b',
  send: '#ffffff',
  sendText: '#0d0d0d',
};

export const space = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radius = {
  sm: 8,
  md: 14,
  lg: 22,
  pill: 999,
};
