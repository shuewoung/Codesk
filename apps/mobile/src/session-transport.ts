// Queue ownership excludes the rotating content key, but includes endpoint and credentials.
export function transportIdentity(creds: {
  mode: string; lanUrl: string; lanPassword: string; localTrusted: boolean;
  relayUrl: string; deviceToken: string; hubId: string;
}): string {
  return JSON.stringify(creds.mode === 'lan'
    ? ['lan', creds.lanUrl, creds.lanPassword, creds.localTrusted]
    : [creds.mode, creds.relayUrl, creds.deviceToken, creds.hubId]);
}

export type PendingApp<T> = { identity: string; message: T };

// Remove only after send succeeds. A failed head and its tail remain in order.
export function drainPending<T>(queue: PendingApp<T>[], identity: string, send: (message: T) => boolean): void {
  while (queue.length) {
    const head = queue[0];
    if (head.identity !== identity) { queue.shift(); continue; }
    try {
      if (!send(head.message)) return;
    } catch { return; }
    queue.shift();
  }
}

// Both onopen and foreground may call start; never install duplicate intervals.
export function createSocketMaintenance(heartbeat: () => void, retry: () => void) {
  let ping: ReturnType<typeof setInterval> | undefined;
  let offline: ReturnType<typeof setInterval> | undefined;
  return {
    start() {
      if (ping === undefined) ping = setInterval(heartbeat, 20000);
      if (offline === undefined) offline = setInterval(retry, 8000);
    },
    stop() {
      clearInterval(ping);
      clearInterval(offline);
      ping = offline = undefined;
    },
  };
}
