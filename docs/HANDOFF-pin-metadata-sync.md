# Handoff: Remote Pin / Metadata Sync to Desktop (Pins, Projects, Order)

**Date**: 2026-08-22
**Status**: **archived / done**（本轮会话归档。sidecar + 空闲物化 + 双向 pin/归档 + PWA/Expo + 速度菜单 + 推理折叠）

## What landed

Remote pin no longer stays on the phone. Hub writes `~/.codex/pins.jsonl` first (same append-only pattern as `session_index.jsonl` titles), serves `thread.isPinned` / `project.isPinned` from override > sidecar > Desktop catalog/sqlite, and only copies into Desktop when it is safe.

- Sidecar + `pinOverrideMap` + `getThreadList` merge for threads **and** projects
- WS: `pin_item` / `pin_thread` / `unpin_thread` (also `pin_project` / `unpin_project`)
- HTTP: `POST /api/threads/pin`, host `POST /api/host/sync-pins`
- `materializePinsIfSafe()`: skip if Codex/ChatGPT process is running, or a fresh writer-lock belongs to a live/owner thread; then atomic-write `.codex-global-state.json` (`pinned-thread-ids` / `pinned-project-ids` / `unified-sidebar-pinned-order-v1`) and try sqlite `threads.is_pinned`
- Watch `.codex-global-state.json`; Desktop pin-set diffs flow back into sidecar + `thread_list`
- PWA: right-click / long-press / click 📌 → `pin_item`
- Expo: `togglePin` sends WS; first `thread_list` migrates old local `onedesk.pins`
- Host console: “立即同步” (still refuses to steal a live turn)
- Archive: `archives.jsonl` + `archive_item` / `POST /api/threads/archive`; Expo/PWA 不再只写本机；sqlite `archived` 空闲物化；Desktop 归档按集合差分拉回
- global-state：目录 watch + mtime 轮询兜底（Windows 原子替换不会丢）
- materialize 2s 节流

## Files

- `apps/web-hub/server/pins.js` + `pins.test.mjs`
- `apps/web-hub/server/index.js`
- `apps/web/app.js` `style.css` `index.html` `host.html`
- `apps/mobile/src/session.tsx` `screens/ThreadScreen.tsx` `screens/ThreadListScreen.tsx`
- `docs/product/04-protocol.md` `README.md` `01-web.md` `02-hub.md` `05-native.md` `docs/PLAN.md`

## How to verify

1. Hub tests: `npm test` in `apps/web-hub` (includes `pins.test.mjs`)
2. Pin from PWA or Expo → `~/.codex/pins.jsonl` grows, remote list shows 📌 immediately
3. Quit Codex Desktop (or wait until idle) → `.codex-global-state.json` `pinned-thread-ids` updates; restart Desktop to see sidebar pin
4. While Desktop is running thread A, pin B remotely → B pinned on phone now; Desktop sees B after idle/quit
5. Pin/unpin in Desktop sidebar → remote `thread_list` follows
6. Sending on an active turn while pinning another thread must not throw writer-lock

## Left out（本轮刻意不做 / 已另做）

- 速度菜单 / 推理折叠：**已做**（`speed` → `service_tier`；推理块默认折叠）
- 归档写回 Desktop：**已做**（`archives.jsonl` + sqlite `archived`）
- `apps/web-hub/public/` 不是主源；PWA 在 `apps/web/`，日常电脑 UI 走 Expo Web `:18991`
- 旧设备重扫 `hk=`、极光重打 APK、持锁审批本机点一次：代码齐，差操作验收
