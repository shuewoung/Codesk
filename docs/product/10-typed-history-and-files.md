# Typed history, images, agents, and Git — implementation and verification

Date: 2026-09-12. Active frontend: `apps/mobile` (Expo Web/native). No archived frontend or extracted proprietary application code was copied or changed for this work. Existing working-tree changes were preserved; no commit, reset, or deployment was performed.

## 中文交付摘要

本次采用自主实现，不复制官方桌面应用代码。展示规则为：正式回复与产物直接展示；普通执行过程分组折叠；错误和审批始终可见；子智能体提供状态、模型（源数据存在时）和子会话入口；Git 与产物放在工作区面板，避免混入正文。

已完成服务端类型化事件归一化、稳定 ID 去重、乱序输出关联、会话范围生成图片授权，以及前端图片/搜索/压缩节点、命令输出、子智能体状态条、单文件 Git 差异、结构化提交、产物分组与筛选、会话摘要徽章。

两项重要修正：普通删除文件和工作目录内名为 `.codex` 的用户文件不会被一概隐藏；生成图片目录不是全目录开放，只允许符合当前已知会话路径规则的图片。产物筛选默认显示全部交付物，不能把“生成的文件”等同于噪音。

主会话已再次运行服务端、移动端和跨模块测试及 TypeScript 检查，结果与下方表格一致。测试导出位于临时目录，未替换运行中的前端、未重启正式 Hub、未提交 Git。

## History design and protocol

`apps/web-hub/server/history-items.js` adapts `event_msg.payload.item` when the payload type is `item_completed`. PascalCase `Reasoning`, `CommandExecution`, `AgentMessage`, `McpToolCall`, `UserMessage`, `FileChange`, `ContextCompaction`, and `ImageView` become the corresponding timeline-compatible types. `Extension` kinds `web.search` and `image_gen.generation` become `web_search` and `generated_image`. Unknown fields, structured output, status, model, and other metadata remain in the record. `callId` is aliased to `call_id`; timestamps and turn IDs are propagated. Malformed completion wrappers without an object item are ignored.

Example normalized record:

```json
{
  "type": "command_execution",
  "id": "item-id",
  "call_id": "call-id",
  "command": "pwd",
  "status": "completed",
  "completed": true,
  "turn_id": "turn-id"
}
```

Completion and function/custom/tool output records are retained instead of discarded. Snapshot deduplication uses stable item ID/call ID aliases, not text. Completed typed records take precedence over invocation counterparts. Output records occupy a separate identity namespace so they can enrich the invocation without replacing it. Equal prose from different records is not treated as a duplicate. Records without stable identity cannot safely be deduplicated and are retained.

The parser remains append-only internally: revisions, file-watch incremental reads, split UTF-8 lines, and delta/baseRev behavior remain intact. Snapshot packing deduplicates the visible item list. `totalItems` continues to count retained raw history records, not rendered cards; `hasMore` is computed from the raw read window. The client honors server pagination rather than comparing raw counts with deduplicated node counts. Incremental deltas can contain completion/output records for earlier invocations; mobile re-correlates them in either arrival order.

## Timeline behavior and defaults

- Dedicated node kinds cover generated images, image views, searches, context compaction, typed file changes, tool calls, reasoning, and agents.
- Tool output is correlated by call ID even when it precedes its invocation. Structured errors, nonzero exit codes, approval states, and denied/failed statuses stay visible with process display disabled and are not buried in command groups. ApprovalBar remains independent of process display.
- Adjacent ordinary commands and agent events fold into groups. Details normalize to at most 16,000 characters and the current expanded text renderer shows up to 4,000 characters. Full original outputs remain in server history; these are preview limits, not a claim that all output is displayed.
- Search cards show the query, collapsible structured details, and up to 20 HTTP(S) result links when a structured `results` array supplies URLs.
- Empty messages/reasoning and empty image records are omitted. Valid Markdown image data is no longer removed during text cleanup.
- Typed FileChange arrays take precedence when a legacy invocation has the same stable identity. Legacy apply_patch supports namespaced calls and multi-file patches. Ordinary deleted files and user files beneath `.codex`-named workspace directories are not suppressed. No heuristic blanket filter for generated files, deletions, or `.codex` paths was introduced. Internal visualization operations are conservatively retained rather than guessed from their filename.

## Images and file-access safety

Local Markdown image references are resolved against the current thread's cwd. Windows absolute paths, POSIX paths, file URLs, relative paths, and WebP are supported. Timeline images use the existing authenticated `get_file` WebSocket channel in LAN, relay, and native modes, avoiding a raw-local-path HTTP bypass. Cached file responses, loading/error feedback, retry, and an explicit FilePreview action are provided. Local image cards open the existing FilePreview screen. HTTP(S) and supported data URLs render inline rather than being sent to the local file service.

Preview bounds:

- Server raster preview: 4 MiB; other file previews retain the existing 800 KiB limit.
- Over-limit raster previews are marked truncated and are not rendered as complete images by the timeline. The user can open FilePreview/original-download handling.
- Inline data URLs: PNG/JPEG/GIF/WebP base64 only, at most 8 MiB of encoded URL text.
- File cache: existing entry-count cap plus a conservative 32 MiB estimated JavaScript-string budget. Cache is reset by existing connection/workspace lifecycle handling.

Generated files remain private by default. The sole new exception is an image file under:

```text
CODEX_HOME/generated_images/<known-thread-id>/
```

The request must supply a thread with server-known workspace metadata. Thread IDs are restricted to letters, digits, underscore, and hyphen before constructing the path. Only PNG/JPEG/WebP/GIF regular files are accepted in this exception. Directory reads, non-image files, another thread's directory, traversal, escaping links, and a redirected/junction root are rejected. Both lexical containment and realpath containment are checked; a generated-image root must resolve to itself. The usual CODEX_HOME/DATA_DIR denial and preexisting upload exception remain in force for all other paths.

Both HTTP `/api/file` and WebSocket `get_file` call the same `fileAccessFor` policy. The existing HTTP/WS authentication gates are unchanged. This is the existing single-user paired-device trust model, not a new multi-user per-thread ACL.

```text
GET /api/file?threadId=<id>&path=<encoded-path>&raw=1
WS  { "type": "get_file", "threadId": "<id>", "path": "<path>" }
WS  { "type": "file_data", "threadId": "<id>", "path": "...",
      "requestPath": "...", "ext": ".webp", "encoding": "base64",
      "content": "...", "truncated": false, "error": null }
```

## Agents

Agent groups and the composer-adjacent status strip expose available titles, statuses, model metadata, and child-thread navigation using actual IDs. FilePanel entries show the same available status/model information. `inter_agent_communication_metadata` is used when present in agent messages. Unknown, waiting, and interrupted statuses remain distinct strings; missing model/status data is not fabricated. Server subagent status prefers parsed state or supplied metadata, with `unknown` rather than an invented completion when no state is available. Explicit turn-aborted/task-interrupted events record interruption.

## Git and artifacts

`UnifiedDiffView` was factored into a shared component. Selecting a Git file opens its own patch inline, not a generic file preview. Both unstaged and staged patches are included. Deletion, rename destination, binary markers, untracked/no-patch states, and no-commit states are preserved. Deleted files do not offer an invalid current-file open action. Git state is displayed only for the matching response thread.

The read-only Git response now adds:

```json
{
  "type": "git_status",
  "threadId": "thread-id",
  "files": [{ "path": "new.txt", "status": "R", "oldPath": "old.txt", "patch": "...", "binary": false, "add": 1, "del": 1 }],
  "commits": [{ "hash": "full-hash", "author": "name", "date": "ISO-date", "subject": "subject", "refs": "decorations" }]
}
```

The legacy `status`, `diff`, and `log` fields remain. Status is NUL-delimited porcelain; log is a NUL-field structured source string. The active frontend consumes `files` and `commits`, not a 1,500-character raw log excerpt. Each Git subprocess has a 15-second/1-MiB output bound; exceeding it reports an incomplete-result error. Diff execution disables external diff and textconv commands. Status filenames use `-z`; quoted diff paths are decoded.

Artifacts accept normalized typed generated-image/file-change evidence as well as existing confirmed tool outputs. Tool invocation lookup supports out-of-order results but rejects ambiguous call-name impersonation. Authorization and file stat remain mandatory. Deletions are excluded only from existing-file deliverables, not from timeline/Git changes. The current turn/cycle visibility rules remain: running turns hide prior artifacts; completion refreshes; unknown-boundary data is labeled session-confirmed. Visible artifacts are grouped by known turn ID. The filter defaults to **all deliverables**, with optional images/other-files views; it does not silently remove user deliverables.

Thread rows accept `summary: { fileChanges, generatedImages, partial }`. Counts use deduplicated typed changes/generated-image records and confirmed legacy patch output in already-loaded server parse state. No full-history request is issued per row. Cold/unindexed threads omit the summary instead of claiming zero; partial windows are labeled “已索引”. These are indexed-history counts, not Git working-tree counts or a complete cold-session inventory.

## Tests and results

All history/file fixtures in this work are synthetic. No real rollout message content or private authentication-token file was inspected for validation.

Commands run from the repository root:

| Command | Result |
| --- | --- |
| `npm --prefix apps/web-hub test` | 161 tests: 160 passed, 1 skipped, 0 failed |
| `npm --prefix apps/mobile test` | 143 tests: 143 passed, 0 skipped/failed |
| `node tests/hub/unit.mjs` | 14/14 passed |
| `npm --prefix apps/mobile run typecheck` | Passed |
| `node --check apps/web-hub/server/index.js` | Passed |
| `node --check apps/web-hub/server/local-cmd.js` | Passed |
| `git diff --check` | Passed; Git emitted existing LF/CRLF conversion warnings |
| `node node_modules/expo/bin/cli export --platform web --output-dir C:\Users\zhang\AppData\Local\Temp\codexweb-final-export-49npi039` (cwd: `apps/mobile`) | Passed; 517 modules, 1.47 MB JS bundle; isolated output, not a deployment |

New coverage includes all listed PascalCase variants, extensions, stable-ID alias dedup, out-of-order outputs, structured errors, ordinary deletion visibility, legacy multi-file patch fallback, typed preference, agent metadata/status preservation, Markdown data URLs, Windows/POSIX local-image resolution, pagination, generated-image path denial, root-junction denial, actual WS handler authorization, shared HTTP policy wiring, typed artifact evidence, structured Git commits, staged deletion and binary changes. The real incremental parser also receives a completion/output append fixture and verifies unchanged-revision rereads.

The single suite skip is the preexisting file-symlink lock safety test: this Windows account cannot create file symlinks. The generated-image test also reports that its optional escaping-file-symlink assertion could not execute for the same reason; root junction denial did execute and pass. Do not interpret the aggregate pass count as verification of that unavailable OS capability.

## Verification limits and rollout

- The subagent browser returned **“Browser is not available in subagent”**. The main session subsequently initialized the browser successfully and performed the limited GUI smoke test below. Interaction coverage remains blocked; it is not a full GUI acceptance pass. No browser-console collection capability was exposed, so no console-clean claim is made.
- Native device builds and real-device LAN/relay image rendering were not exercised. Unit tests and the Expo web export do not substitute for these checks.
- The WS file-handler test executes the actual handler in an isolated fixture. HTTP parity additionally verifies shared policy wiring and the existing auth/file suites; it is not a new live end-to-end HTTP authentication test.
- Stable-ID-free duplicate formats cannot be safely collapsed by text. Unknown schemas/metadata remain preserved on the server but are not promised a specialized card until mapped.
- Model metadata appears only when the source supplies it. Cold thread summaries intentionally remain absent until history is indexed.
- Existing `apps/mobile/dist-web` and backup exports were left untouched. To deploy after review, run the normal `npm --prefix apps/mobile run export:web` and the project's usual Hub restart procedure. The verification exports were built in temporary directories to avoid replacing a running frontend.

## 主会话隔离浏览器冒烟测试

### 测试准备

在临时目录创建独立 Hub 副本、合成 rollout、临时 Git 仓库和图片。前端复用上方最终导出，入口文件校验一致。只有临时 Hub 副本调整为 localhost 绑定、禁用 relay 启动/孤儿清理、隔离桌面 IPC 与用户目录、使用不存在的 Codex 可执行文件，避免真实模型调用。正式工作区源文件和运行中的 Hub 未因测试被替换。

初始 `127.0.0.1:51465` 地址被现有前端 loopback 自动映射逻辑指向固定 18990 端口，故该准备尝试无效。经验证改用 `http://localhost.:51465/`，保留正确临时端口。仅在测试准备阶段，把通过临时 Hub 正常登录取得的合成账号凭证写入该临时 origin 的连接存储，然后重新加载。没有预设待测节点的 UI 展开/选择状态。

独立接口检查确认：登录和带 browser Origin 的认证 WebSocket 成功；当前会话生成图片 HTTP 200，其他会话请求同一图片 HTTP 403；Git 返回结构化文件与提交；产物返回三个已确认文件。父会话为空闲，子会话分别为 interrupted / waiting_approval。此验证使用临时副本，不等于部署后真实环境验收。

### 结果与截图

**T1 初始三栏渲染：通过有限范围检查。** DOM 和截图共同确认：生成图片正常显示，搜索结果与错误提示可见，产物区有三个文件，线程行有 `3 文件 · 1 图片` 统计。截图未覆盖的下方内容不纳入视觉通过结论。

![初始时间线、生成图片与产物列表](../../gui-test-screenshots/typed-history/t1-initial-render.png)

**T2 Git 面板交互：受阻，未通过验收。** 页面 DOM 与截图都有 `Git` 入口，但正常定位点击返回 `Timeout waiting for locator internal:text="Git"s`，随后页面仍停留在产物面板。未用脚本触发事件或其他强制方式绕过。不能据此断言是产品缺陷还是控制工具问题。

![Git 点击超时后的现场](../../gui-test-screenshots/typed-history/t2-git-click-blocked.png)

**T3 底部回复/子智能体交互：受阻。** 浏览器普通滚动返回 `browser 命令 cuaScroll 超时（30000ms）`。DOM 能读到子会话状态，但没有取得其可见截图，因此不记为视觉通过。单文件 diff 展开、筛选切换、子会话跳转、完整 Markdown 图片与移动端尺寸交互均未获得完整 GUI 验收；对应自动化测试结果仍如上表，不与 GUI 结果混淆。

测试准备还出现过配对按钮点击超时和一次截图捕获错误；后续静态截图成功。截图证据保存在仓库 `gui-test-screenshots/typed-history/`，不包含真实用户会话内容或真实凭证。

测试完成后，已核对临时进程命令行并停止该 Hub，确认进程退出，同时关闭临时浏览器标签页。临时目录和日志保留用于复查，依赖 junction 未递归删除，正式 Hub 未被停止。
