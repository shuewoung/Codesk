@echo off
title Codesk Hub
cd /d "%~dp0..\apps\web-hub"
if not exist node_modules (
  echo [Codesk] npm install...
  call npm install
)
if not defined ONEDESK_RELAY_URL (
  if defined CODESK_RELAY_URL (
    set ONEDESK_RELAY_URL=%CODESK_RELAY_URL%
  ) else (
    set ONEDESK_RELAY_URL=https://hub.codesk.icu:8787
  )
)
echo [Codesk] http://127.0.0.1:18990
echo [Codesk] relay %ONEDESK_RELAY_URL%
node server/index.js
pause
