import * as SecureStore from 'expo-secure-store';
import { createPendingCommandStorage, pendingCommand, type PendingCommand } from './pending-commands';
import { Platform } from 'react-native';
import {
  createDraftStorage,
  type ComposerDraft,
} from './composer-draft';
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
const KEY_PROCESS = 'onedesk.showProcess';
const KEY_LIST_SORT = 'onedesk.listSort';
const KEY_HK = 'onedesk.hubE2ePub';
const KEY_DEV = 'onedesk.e2eDevice';
const KEY_CK = 'onedesk.contentKey';
const KEY_KID = 'onedesk.keyId';
const KEY_LAN = 'onedesk.lanUrl';
const KEY_LAN_PW = 'onedesk.lanPassword';
const KEY_MODE = 'onedesk.connMode';
const KEY_AUTH_REQUIRED = 'onedesk.authRequired';
const DEFAULT_RELAY_URL = 'https://hub.codesk.icu:8787';

export type StoredSession = {
  authRequired?: boolean;
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
  const [relayUrl, deviceToken, hubId, hubE2ePub, contentKey, keyId, lanUrl, lanPassword, mode, authRequired] = await Promise.all([
    kvGet(KEY_RELAY),
    kvGet(KEY_TOKEN),
    kvGet(KEY_HUB),
    kvGet(KEY_HK),
    kvGet(KEY_CK),
    kvGet(KEY_KID),
    kvGet(KEY_LAN),
    kvGet(KEY_LAN_PW),
    kvGet(KEY_MODE),
    kvGet(KEY_AUTH_REQUIRED),
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
    authRequired: authRequired === '1',
  };
}

export async function saveSession(next: Partial<StoredSession>): Promise<void> {
  const writes: Promise<void>[] = [];
  if (next.authRequired !== undefined) writes.push(next.authRequired ? kvSet(KEY_AUTH_REQUIRED, '1') : kvDel(KEY_AUTH_REQUIRED));
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
  const extras: [keyof StoredSession, string][] = [
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
    kvDel(KEY_AUTH_REQUIRED),
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

export async function loadShowProcess(): Promise<boolean> {
  const value = await kvGet(KEY_PROCESS);
  if (value === '1' || value === 'true') return true;
  return false;
}

export async function saveShowProcess(on: boolean): Promise<void> {
  await kvSet(KEY_PROCESS, on ? '1' : '0');
}

export type ListSort = 'catalog' | 'recent';

export async function loadListSort(): Promise<ListSort> {
  const value = await kvGet(KEY_LIST_SORT);
  return value === 'recent' ? 'recent' : 'catalog';
}

export async function saveListSort(name: ListSort): Promise<void> {
  await kvSet(KEY_LIST_SORT, name);
}

const KEY_PINS = 'onedesk.pins';
const KEY_ARCHIVED = 'onedesk.archived';
const KEY_OPEN_PROJECTS = 'onedesk.openProjects';

export async function loadOpenProjects(): Promise<Record<string, boolean>> {
  const raw = await kvGet(KEY_OPEN_PROJECTS);
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveOpenProjects(openMap: Record<string, boolean>): Promise<void> {
  await kvSet(KEY_OPEN_PROJECTS, JSON.stringify(openMap));
}
const KEY_DRAFTS = 'onedesk.composerDrafts';

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

const PENDING_KEY = 'onedesk.pendingCommands.v1';
const nativePending = createPendingCommandStorage(() => SecureStore.getItemAsync(PENDING_KEY), raw => SecureStore.setItemAsync(PENDING_KEY, raw));
function pendingWebStore(): Storage {
  // A memory fallback is not durable enough to authorize dispatch.
  if (typeof localStorage === 'undefined') throw new Error('持久存储不可用');
  return localStorage;
}
function pendingWebKey(namespace: string, requestId: string) { return `${PENDING_KEY}:${encodeURIComponent(namespace)}:${encodeURIComponent(requestId)}`; }
export async function loadPendingCommands(namespace: string): Promise<PendingCommand[]> {
  if (Platform.OS !== 'web') return nativePending.load(namespace);
  const store = pendingWebStore(); const prefix = `${PENDING_KEY}:${encodeURIComponent(namespace)}:`;
  const result: PendingCommand[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i); if (!key?.startsWith(prefix)) continue;
    const raw = store.getItem(key); if (raw === null) continue;
    const row = pendingCommand(JSON.parse(raw));
    if (row.namespace === namespace) result.push(row);
  }
  return result;
}
export async function savePendingCommand(value: PendingCommand): Promise<void> {
  const row = pendingCommand(value);
  if (Platform.OS !== 'web') return nativePending.put(row);
  // One key per command avoids cross-tab read/modify/write lost updates.
  pendingWebStore().setItem(pendingWebKey(row.namespace, row.requestId), JSON.stringify(row));
}
export async function removePendingCommand(namespace: string, requestId: string): Promise<void> {
  if (Platform.OS !== 'web') return nativePending.remove(namespace, requestId);
  pendingWebStore().removeItem(pendingWebKey(namespace, requestId));
}

const draftStorage = createDraftStorage(() => kvGet(KEY_DRAFTS), (raw) => kvSet(KEY_DRAFTS, raw));

export async function loadComposerDraftMapRaw(): Promise<string | null> {
  return draftStorage.readRaw();
}

export async function saveComposerDraftMapRaw(raw: string): Promise<void> {
  return draftStorage.writeRaw(raw);
}

export async function loadComposerDraft(threadId: string): Promise<ComposerDraft | null> {
  return draftStorage.load(threadId);
}

export async function saveComposerDraft(threadId: string, draft: ComposerDraft | null): Promise<void> {
  return draftStorage.save(threadId, draft);
}

export async function clearComposerDraftIfSending(threadId: string, text: string): Promise<void> {
  return draftStorage.clearSending(threadId, text);
}

export const migrateComposerDraftNamespace = draftStorage.migrateNamespace;
export const claimLegacyComposerDraft = draftStorage.claimLegacy;
export const appendComposerAttachment = draftStorage.appendAttachment;
export const removeComposerAttachment = draftStorage.removeAttachment;
export async function loadCustomPrompts(): Promise<string[]> {
  try { const rows = JSON.parse(await kvGet('onedesk.prompts') || '[]'); return Array.isArray(rows) ? rows.filter((s: unknown) => typeof s === 'string').slice(0, 20) : []; } catch { return []; }
}
export async function saveCustomPrompts(prompts: string[]): Promise<void> { await kvSet('onedesk.prompts', JSON.stringify(prompts.slice(0, 20))); }
