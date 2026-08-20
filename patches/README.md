# 原版 UI asar 补丁

仅用于 `codex-web-upstream` 的 `prepare_asar`。重建上游时按顺序拷回 `codex-web-upstream/patches/`：

1. `shell-catalog-sync-foreground.patch`
2. `shell-catalog-sync-startup.patch`
3. `webview-project-order-static.patch`

产品控制面是 `apps/web-hub`，不再给这些补丁加会话跟随/审批逻辑。
