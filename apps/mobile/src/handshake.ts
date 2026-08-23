export type HandshakePhase =
  | 'idle'
  | 'socket'
  | 'e2e'
  | 'sync'
  | 'ready'
  | 'offline'
  | 'reconnecting';

export type HandshakeState = 'wait' | 'now' | 'ok' | 'fail' | 'skip';

export type HandshakeStep = {
  key: 'relay' | 'auth' | 'e2e' | 'sync';
  label: string;
  state: HandshakeState;
};

export type HandshakeView = {
  phase: HandshakePhase;
  steps: HandshakeStep[];
  title: string;
  detail: string;
  active: boolean;
  needsRetry: boolean;
};

function mark(
  keys: HandshakeStep['key'][],
  labels: Record<HandshakeStep['key'], string>,
  doneThrough: number,
  current: number,
  failed: boolean,
): HandshakeStep[] {
  return keys.map((key, i) => {
    let state: HandshakeState = 'wait';
    if (i < doneThrough) state = 'ok';
    else if (i === current) state = failed ? 'fail' : 'now';
    return { key, label: labels[key], state };
  });
}

export function buildHandshake(opts: {
  mode: 'lan' | 'relay' | '';
  phase: HandshakePhase;
  error?: string;
}): HandshakeView {
  const lan = opts.mode === 'lan';
  const labels: Record<HandshakeStep['key'], string> = lan
    ? {
      relay: '连接电脑',
      auth: '本机鉴权',
      e2e: '局域网直连',
      sync: '同步工作区',
    }
    : {
      relay: '连接中继',
      auth: '设备鉴权',
      e2e: '加密握手',
      sync: '同步工作区',
    };
  const keys: HandshakeStep['key'][] = ['relay', 'auth', 'e2e', 'sync'];
  const failed = Boolean(opts.error) && (opts.phase === 'socket' || opts.phase === 'e2e' || opts.phase === 'sync' || opts.phase === 'idle');
  const err = String(opts.error || '').trim();

  if (opts.phase === 'idle') {
    return {
      phase: 'idle',
      steps: mark(keys, labels, 0, -1, false),
      title: '未连接',
      detail: lan ? '用家里码连电脑。' : '扫主机台右边的出门码。',
      active: false,
      needsRetry: false,
    };
  }
  if (opts.phase === 'offline') {
    return {
      phase: 'offline',
      steps: mark(keys, labels, 3, 3, true),
      title: '主机离线',
      detail: '电脑休眠或 Hub 没开。电脑醒了才能发消息。',
      active: true,
      needsRetry: true,
    };
  }
  if (opts.phase === 'reconnecting') {
    return {
      phase: 'reconnecting',
      steps: mark(keys, labels, 0, 0, false),
      title: '正在重连',
      detail: err || (lan ? '正在重新连接电脑。' : '正在重新连接中继。'),
      active: true,
      needsRetry: Boolean(err),
    };
  }
  if (opts.phase === 'ready') {
    const steps = mark(keys, labels, 4, -1, false);
    if (lan) steps[2] = { ...steps[2], state: 'skip', label: '局域网明文' };
    return {
      phase: 'ready',
      steps,
      title: lan ? '已直连' : '中继已连接',
      detail: '',
      active: false,
      needsRetry: false,
    };
  }

  let doneThrough = 0;
  let current = 0;
  let title = lan ? '正在连接电脑' : '正在连接中继';
  let detail = lan ? '正在连本机 Hub。' : '正在连中转服务。';

  if (opts.phase === 'socket') {
    doneThrough = 0;
    current = 0;
  } else if (opts.phase === 'e2e') {
    doneThrough = 2;
    current = 2;
    title = '加密握手';
    detail = err || '已连上中继，正在交换密钥。若一直停在这，请装新版 APK，退出后再扫右边出门码（须带 hk=）。';
  } else if (opts.phase === 'sync') {
    doneThrough = 3;
    current = 3;
    title = '同步工作区';
    detail = err || '握手完成，正在拉取会话列表。';
  }

  const steps = mark(keys, labels, doneThrough, current, failed && current >= 0);
  if (lan) {
    if (opts.phase === 'sync' || opts.phase === 'e2e') {
      steps[0].state = 'ok';
      steps[1].state = 'ok';
      steps[2] = { key: 'e2e', label: '局域网明文', state: 'skip' };
    }
  }

  return { phase: opts.phase, steps, title, detail, active: true, needsRetry: failed };
}

export function handshakeHint(error: string): string {
  const raw = String(error || '');
  if (/prng/i.test(raw)) return '当前安装包缺随机数，请安装新版 APK 后再配对。';
  if (/hk=|重新扫|握手失败|e2e/i.test(raw)) return '请退出后重新扫描主机台右边带 hk= 的出门码。';
  if (/旧版|新版 APK|加密握手没完成/i.test(raw)) return raw;
  return raw;
}
