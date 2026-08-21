import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { normalizeRelayUrl } from './protocol';
import type { ThemeName } from './theme';

const memory = new Map<string, string>();

function webGet(key: string): string | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(key);
  } catch {
    /* ignore */
  }
  return memory.get(key) ?? null;
}

function webSet(key: string, value: string): void {
  memory.set(key, value);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function webDel(key: string): void {
  memory.delete(key);
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

async function kvGet(key: string): Promise<string | null> {
  if (Platform.OS !== 'web') return SecureStore.getItemAsync(key);
  try {
    if (await SecureStore.isAvailableAsync()) {
      const value = await SecureStore.getItemAsync(key);
      if (value != null) return value;
    }
  } catch {
    /* localStorage */
  }
  return webGet(key);
}

async function kvSet(key: string, value: string): Promise<void> {
  if (Platform.OS !== 'web') {
    await SecureStore.setItemAsync(key, value);
    return;
  }
  try {
    if (await SecureStore.isAvailableAsync()) {
      await SecureStore.setItemAsync(key, value);
      return;
    }
  } catch {
    /* localStorage */
  }
  webSet(key, value);
}

async function kvDel(key: string): Promise<void> {
  if (Platform.OS !== 'web') {
    await SecureStore.deleteItemAsync(key);
    return;
  }
  try {
    if (await SecureStore.isAvailableAsync()) await SecureStore.deleteItemAsync(key);
  } catch {
    /* localStorage */
  }
  webDel(key);
}

const KEY_RELAY = 'onedesk.relayUrl';
const KEY_TOKEN = 'onedesk.deviceToken';
const KEY_HUB = 'onedesk.hubId';
const KEY_THEME = 'onedesk.theme';
const KEY_DENSITY = 'onedesk.listDensity';
const KEY_HK = 'onedesk.hubE2ePub';
const KEY_DEV = 'onedesk.e2eDevice';
const KEY_CK = 'onedesk.contentKey';
const KEY_KID = 'onedesk.keyId';
const KEY_LAN = 'onedesk.lanUrl';
const KEY_LAN_PW = 'onedesk.lanPassword';
const KEY_MODE = 'onedesk.connMode';
const DEFAULT_RELAY_URL = 'https://hub.codesk.icu:8787';

export type StoredSession = {
  relayUrl: string;
  deviceToken: string;
  hubId: string;
  hubE2ePub: string;
  contentKey: string;
  keyId: string;
  lanUrl: string;
  lanPassword: string;
  mode: 'relay' | 'lan' | '';
};

export async function loadSession(): Promise<StoredSession> {
  const envDefault = normalizeRelayUrl(process.env.EXPO_PUBLIC_RELAY_URL || DEFAULT_RELAY_URL);
  const [relayUrl, deviceToken, hubId, hubE2ePub, contentKey, keyId, lanUrl, lanPassword, mode] = await Promise.all([
    kvGet(KEY_RELAY),
    kvGet(KEY_TOKEN),
    kvGet(KEY_HUB),
    kvGet(KEY_HK),
    kvGet(KEY_CK),
    kvGet(KEY_KID),
    kvGet(KEY_LAN),
    kvGet(KEY_LAN_PW),
    kvGet(KEY_MODE),
  ]);
  return {
    relayUrl: normalizeRelayUrl(relayUrl || '') || envDefault,
    deviceToken: deviceToken || '',
    hubId: hubId || '',
    hubE2ePub: hubE2ePub || '',
    contentKey: contentKey || '',
    keyId: keyId || '',
    lanUrl: lanUrl || '',
    lanPassword: lanPassword || '',
    mode: mode === 'lan' || mode === 'relay' ? mode : '',
  };
}

export async function saveSession(next: Partial<StoredSession>): Promise<void> {
  const writes: Promise<void>[] = [];
  if (next.relayUrl !== undefined) {
    const value = normalizeRelayUrl(next.relayUrl);
    writes.push(value ? kvSet(KEY_RELAY, value) : kvDel(KEY_RELAY));
  }
  if (next.deviceToken !== undefined) {
    writes.push(next.deviceToken ? kvSet(KEY_TOKEN, next.deviceToken) : kvDel(KEY_TOKEN));
  }
  if (next.hubId !== undefined) {
    writes.push(next.hubId ? kvSet(KEY_HUB, next.hubId) : kvDel(KEY_HUB));
  }
  const extras: Array<[keyof StoredSession, string]> = [
    ['hubE2ePub', KEY_HK],
    ['contentKey', KEY_CK],
    ['keyId', KEY_KID],
    ['lanUrl', KEY_LAN],
    ['lanPassword', KEY_LAN_PW],
    ['mode', KEY_MODE],
  ];
  for (const [field, key] of extras) {
    if (next[field] !== undefined) {
      const value = String(next[field] || '');
      writes.push(value ? kvSet(key, value) : kvDel(key));
    }
  }
  await Promise.all(writes);
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    kvDel(KEY_RELAY),
    kvDel(KEY_TOKEN),
    kvDel(KEY_HUB),
    kvDel(KEY_HK),
    kvDel(KEY_CK),
    kvDel(KEY_KID),
    kvDel(KEY_LAN),
    kvDel(KEY_LAN_PW),
    kvDel(KEY_MODE),
    kvDel(KEY_DEV),
  ]);
}

export async function loadDeviceKeys(): Promise<{ publicKey: string; secretKey: string } | null> {
  const raw = await kvGet(KEY_DEV);
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.publicKey && parsed.secretKey) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

export async function saveDeviceKeys(keys: { publicKey: string; secretKey: string }): Promise<void> {
  await kvSet(KEY_DEV, JSON.stringify(keys));
}

export async function loadTheme(): Promise<ThemeName> {
  const value = await kvGet(KEY_THEME);
  return value === 'dark' ? 'dark' : 'light';
}

export async function saveTheme(name: ThemeName): Promise<void> {
  await kvSet(KEY_THEME, name);
}

export type ListDensity = 'compact' | 'comfortable';

export async function loadListDensity(): Promise<ListDensity> {
  const value = await kvGet(KEY_DENSITY);
  return value === 'comfortable' ? 'comfortable' : 'compact';
}

export async function saveListDensity(name: ListDensity): Promise<void> {
  await kvSet(KEY_DENSITY, name);
}

const KEY_PINS = 'onedesk.pins';
const KEY_ARCHIVED = 'onedesk.archived';

export async function loadIdSet(kind: 'pins' | 'archived'): Promise<string[]> {
  const raw = await kvGet(kind === 'pins' ? KEY_PINS : KEY_ARCHIVED);
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveIdSet(kind: 'pins' | 'archived', ids: string[]): Promise<void> {
  await kvSet(kind === 'pins' ? KEY_PINS : KEY_ARCHIVED, JSON.stringify(ids));
}
