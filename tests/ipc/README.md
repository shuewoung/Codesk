# codex-ipc Host Router 探针

独立 Node 当 IpcClient，验证桌面/VSCode JS Host 是否认领 thread。

```powershell
node tests/ipc/host-router-spike.mjs
node tests/ipc/host-router-spike.mjs <threadId> --interrupt
```

A 成功：`initialize` 拿到 `clientId`，`thread-owner-discovery` 返回 `handledByClientId`。  
B 仅在加 `--interrupt` 时发送 `thread-follower-interrupt-turn`（无 `expectedTurnId`，走 v3）。

审批探针（Desktop 开着并弹出审批时）：

```powershell
node tests/ipc/follower-approval-spike.mjs <threadId> --dry-run
node tests/ipc/follower-approval-spike.mjs <threadId> <requestId> --kind command --decision accept
```

`requestId` 必须是 Desktop app-server 正在等待的 JSON-RPC id，不要用 JSONL 条目 id。
