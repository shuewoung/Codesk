@echo off
setlocal
cd /d "%~dp0..\apps\web-hub"
if not exist node_modules (
  echo [Codesk] npm install...
  call npm install
  if errorlevel 1 exit /b 1
)
if not defined ONEDESK_RELAY_URL (
  if defined CODESK_RELAY_URL (
    set ONEDESK_RELAY_URL=%CODESK_RELAY_URL%
  ) else (
    set ONEDESK_RELAY_URL=https://hub.codesk.icu:8787
  )
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-web-hub.ps1" %*
exit /b %ERRORLEVEL%
