@echo off
setlocal
set CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo 找不到 csc.exe
  exit /b 1
)
"%CSC%" /nologo /target:winexe /r:System.Windows.Forms.dll /out:"%~dp0CodeskHub.exe" "%~dp0CodeskHub.cs"
if errorlevel 1 exit /b 1
if not exist "%LOCALAPPDATA%\OneDesk" mkdir "%LOCALAPPDATA%\OneDesk"
> "%LOCALAPPDATA%\OneDesk\hub-dir.txt" echo %~dp0..\apps\web-hub
echo 已生成 %~dp0CodeskHub.exe
