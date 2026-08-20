type JPushMod = {
  init: (opts: { appKey: string; channel: string; production: boolean }) => void;
  getRegistrationID: (cb: (res: { registerID?: string }) => void) => void;
};

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

export async function getJpushRegistrationId(): Promise<string> {
  if (typeof document !== 'undefined' || isExpoGo()) return '';
  const appKey = readAppKey();
  if (!appKey) return '';
  try {
    const mod = 'jpush-react-native';
    const JPush = require(mod) as JPushMod;
    JPush.init({ appKey, channel: 'developer-default', production: true });
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
