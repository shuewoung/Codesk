type JPushMod = {
  init: (opts: { appKey: string; channel: string; production: boolean }) => void;
  getRegistrationID: (cb: (res: { registerID?: string }) => void) => void;
  addNotificationListener?: (cb: (res: Record<string, unknown>) => void) => void;
  getLaunchAppNotification?: (cb: (res: Record<string, unknown>) => void) => void;
};

type OpenHandler = (threadId: string) => void;

const THREAD_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const openHandlers = new Set<OpenHandler>();
let jpushReady = false;
let lastOpenId = '';
let lastOpenAt = 0;

function isExpoGo(): boolean {
  try {
    const Constants = require('expo-constants').default as { appOwnership?: string | null };
    return Constants.appOwnership === 'expo';
  } catch {
    return true;
  }
}

function readAppKey(): string {
  try {
    const Constants = require('expo-constants').default as {
      expoConfig?: { extra?: { jpushAppKey?: string } };
    };
    return Constants.expoConfig?.extra?.jpushAppKey || '';
  } catch {
    return '';
  }
}

export function threadIdFromPush(value: unknown): string {
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return (
      threadIdFromPush(rec.threadId)
      || threadIdFromPush(rec.url)
      || threadIdFromPush(rec.tag)
      || threadIdFromPush(rec.extras)
    );
  }
  const text = String(value || '');
  const fromHash = text.match(/#thread-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (fromHash) return fromHash[1];
  const fromTag = text.match(/codex-(?:done|approval)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (fromTag) return fromTag[1];
  const any = text.match(THREAD_ID_RE);
  return any ? any[0] : '';
}

function parseExtras(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try { return parseExtras(JSON.parse(trimmed)); } catch { /* ignore */ }
    }
    return { tag: trimmed };
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

function threadIdFromNotification(res: Record<string, unknown> | null | undefined): string {
  if (!res) return '';
  const extras = parseExtras(res.extras ?? res.extra);
  return threadIdFromPush(extras) || threadIdFromPush(res);
}

function emitOpen(threadId: string) {
  const id = String(threadId || '').trim();
  if (!id) return;
  const now = Date.now();
  if (id === lastOpenId && now - lastOpenAt < 1500) return;
  lastOpenId = id;
  lastOpenAt = now;
  for (const fn of openHandlers) fn(id);
}

function loadJPush(): JPushMod | null {
  if (typeof document !== 'undefined' || isExpoGo()) return null;
  const appKey = readAppKey();
  if (!appKey) return null;
  try {
    const mod = 'jpush-react-native';
    return require(mod) as JPushMod;
  } catch {
    return null;
  }
}

function ensureJpushListeners() {
  if (jpushReady) return;
  const JPush = loadJPush();
  if (!JPush) return;
  jpushReady = true;
  const appKey = readAppKey();
  JPush.init({ appKey, channel: 'developer-default', production: true });
  JPush.addNotificationListener?.((res) => {
    const event = String(res?.notificationEventType || res?.eventType || '');
    if (event && event !== 'notificationOpened' && event !== 'notification_opened') return;
    emitOpen(threadIdFromNotification(res));
  });
  JPush.getLaunchAppNotification?.((res) => {
    emitOpen(threadIdFromNotification(res));
  });
}

export async function getJpushRegistrationId(): Promise<string> {
  const JPush = loadJPush();
  if (!JPush) return '';
  const appKey = readAppKey();
  if (!appKey) return '';
  try {
    JPush.init({ appKey, channel: 'developer-default', production: true });
    ensureJpushListeners();
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(''), 4000);
      JPush.getRegistrationID((res) => {
        clearTimeout(timer);
        resolve(String(res?.registerID || '').trim());
      });
    });
  } catch {
    return '';
  }
}

export function subscribeJpushOpens(onOpen: OpenHandler): () => void {
  openHandlers.add(onOpen);
  if (lastOpenId) onOpen(lastOpenId);
  try { ensureJpushListeners(); } catch { /* native optional */ }
  return () => { openHandlers.delete(onOpen); };
}
