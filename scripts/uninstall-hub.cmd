@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$names = @('Codesk Hub.lnk');" ^
  "$dirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Startup'));" ^
  "foreach ($d in $dirs) { foreach ($n in $names) { $p = Join-Path $d $n; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force } } }"
echo [Codesk] 已去掉桌面和开机启动快捷方式。托盘里选退出即可停掉本次运行。
pause
