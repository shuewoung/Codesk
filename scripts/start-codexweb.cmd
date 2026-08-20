@echo off
rem 启动 CodexWeb（原版 Codex UI 浏览器镜像）
rem 前置：本脚本依赖 codex-web-upstream\ 已完成 npm install + prepare（见 README）
setlocal
cd /d "%~dp0..\codex-web-upstream"
set CODEX_CLI_PATH=%~dp0..\codex-bin\codex.exe
echo [CodexWeb] 启动中... 浏览器打开 http://127.0.0.1:8214
node src/server/main.js --port 8214
