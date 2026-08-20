// host-polyfill.js
// 浏览器侧替代 Electron preload 的桥接层（v2）
// 真 preload 的行为（对照 app.asar 里 preload.js）：
//   - window 收到 {type:'connect-app-host', port} 消息
//   - 把 port 转发给主进程（我们的场景：连到 WebSocket <-> codex-ipc 管道）
// 本 polyfill 不自己创建 MessageChannel，只监听应用的 connect-app-host 并接管 port。
(function () {
  'use strict';

  console.log('[HostPolyfill] v2 初始化');

  let ws = null;
  let activePort = null; // 应用通过 connect-app-host 移交的 port

  const bridge = {
    windowType: 'electron',
    acknowledgeChunkedMessage: () => {},
    getPreloadStartedAtMs: () => performance.timeOrigin,
    sendMessageFromView: async (msg) => {
      if (activePort) activePort.postMessage(msg);
    },
    getPathForFile: () => null,
    startFileDrag: () => false,
    sendWorkerMessageFromView: async (workerName, msg) => {
      if (activePort) activePort.postMessage({ type: 'worker-message', workerName, message: msg });
    },
    subscribeToWorkerMessages: (workerName, listener) => {
      window.__workerListeners = window.__workerListeners || new Map();
      const set = window.__workerListeners.get(workerName) || new Set();
      set.add(listener);
      window.__workerListeners.set(workerName, set);
      return () => set.delete(listener);
    },
    showContextMenu: async () => {},
    getFastModeRolloutMetrics: async () => null,
    getSharedObjectSnapshotValue: () => null,
    getInitialSidebarBootstrap: () => null,
    getSystemThemeVariant: () => 'dark',
    subscribeToSystemThemeVariant: () => () => {},
    triggerSentryTestError: async () => {},
    getSentryInitOptions: () => ({ appVersion: '0.0.0', buildFlavor: 'web' }),
    getDesktopUserAgent: () => 'Codex Desktop/web (Windows NT 10.0; x64)',
    getAppSessionId: () => null,
    getBuildFlavor: () => 'web',
    isDeviceCheckSupported: () => false,
    isIntelMacBuild: () => false,
    usesOwlAppShell: () => false,
  };

  window.electronBridge = bridge;
  window.codexWindowType = 'electron';

  // 连接 WebSocket -> codex-ipc 管道（经 run-proxy 透传）
  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);
    ws.binaryType = 'arraybuffer';

    ws.onmessage = (e) => {
      // 服务端数据 -> 应用（经 port）
      if (activePort) {
        try { activePort.postMessage(e.data); } catch (err) { console.error('[HostPolyfill] port.postMessage:', err); }
      }
    };
    ws.onclose = (ev) => {
      console.log('[HostPolyfill] WS 关闭 code=', ev.code, 'clean=', ev.wasClean);
      setTimeout(() => { if (!ws || ws.readyState === WebSocket.CLOSED) connectWS(); }, 1500);
    };
    ws.onerror = (e) => console.error('[HostPolyfill] WS 错误:', e);
    ws.onopen = () => console.log('[HostPolyfill] WS 已连接');
  }

  // 核心：接管应用发来的 connect-app-host port
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.type !== 'connect-app-host') return;
    const port = e.data.port;
    if (!port) return;
    console.log('[HostPolyfill] 接管 connect-app-host port');

    // 防止重复接管
    if (activePort && activePort !== port) {
      try { activePort.close(); } catch {}
    }
    activePort = port;
    port.onmessage = (ev) => {
      // 应用 -> 服务端
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(ev.data); } catch (err) { console.error('[HostPolyfill] ws.send:', err); }
      }
    };
    port.start && port.start();

    // 确保 WS 已连接
    if (!ws || ws.readyState === WebSocket.CONNECTING) {
      // 等待连接
    } else if (ws.readyState === WebSocket.CLOSED) {
      connectWS();
    }
  });

  // 立即建立 WS
  connectWS();

  console.log('[HostPolyfill] v2 加载完成');
})();
