@echo off
setlocal
title Install Codesk Hub
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [Codesk] 找不到 node。请先安装 Node.js 22 LTS。
  echo https://nodejs.org/
  pause
  exit /b 1
)

cd /d "%~dp0..\apps\web-hub"
if not exist node_modules (
  echo [Codesk] npm install...
  call npm install
  if errorlevel 1 (
    echo [Codesk] npm install 失败
    pause
    exit /b 1
  )
)

set CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if exist "%CSC%" (
  "%CSC%" /nologo /target:winexe /r:System.Windows.Forms.dll /out:"%~dp0CodeskHub.exe" "%~dp0CodeskHub.cs"
)

if not exist "%LOCALAPPDATA%\OneDesk" mkdir "%LOCALAPPDATA%\OneDesk"
> "%LOCALAPPDATA%\OneDesk\hub-dir.txt" echo %~dp0..\apps\web-hub

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w = New-Object -ComObject WScript.Shell;" ^
  "$desk = [Environment]::GetFolderPath('Desktop');" ^
  "$start = [Environment]::GetFolderPath('Startup');" ^
  "$cmd = Join-Path '%~dp0' 'start-hub-tray.cmd';" ^
  "$exe = Join-Path '%~dp0' 'CodeskHub.exe';" ^
  "foreach ($dir in @($desk,$start)) {" ^
  "  if (Test-Path -LiteralPath $exe) { Copy-Item -LiteralPath $exe -Destination (Join-Path $dir 'CodeskHub.exe') -Force }" ^
  "  else {" ^
  "    $sc = $w.CreateShortcut((Join-Path $dir 'Codesk Hub.lnk'));" ^
  "    $sc.TargetPath = $cmd; $sc.WorkingDirectory = '%~dp0'; $sc.WindowStyle = 7; $sc.Save()" ^
  "  }" ^
  "}"

netsh advfirewall firewall delete rule name="Codesk Hub 18990" >nul 2>nul
netsh advfirewall firewall add rule name="Codesk Hub 18990" dir=in action=allow protocol=TCP localport=18990 >nul 2>nul

echo [Codesk] 已放到桌面，并设置开机启动。
echo [Codesk] 右下角托盘点开即可扫码；可查看/踢掉客户端。
start "" "%~dp0start-hub-tray.cmd"
echo.
pause
