$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Dest = Join-Path $env:LOCALAPPDATA "Programs\Codesk"
$InstallId = [Guid]::NewGuid().ToString('N')
$TmpDir = Join-Path ([IO.Path]::GetTempPath()) ("codesk-hub-install-" + $InstallId)
$Stage = "$Dest.staging-$InstallId"
$Backup = "$Dest.backup-$InstallId"
$ZipPath = Join-Path $TmpDir "CodeskHub-windows.zip"
$ExeName = "CodeskHub.exe"
# Resolve latest exactly once. The website download redirects to mutable latest,
# so it is not a safe version-pinned mirror and is deliberately not used here.
function ConvertTo-StableVersion([string]$Value) {
  if ($Value -notmatch '^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
    throw "无法验证稳定版本：$Value"
  }
  return [version]($Value -replace '^v', '')
}

function Test-LaunchStatus($Status, [string]$LaunchId, [string]$Version) {
  return ($Status.success -eq $true -and $Status.hubId -and $Status.port -eq 18990 -and
    $Status.launchId -ceq $LaunchId -and $Status.version -ceq $Version -and
    $Status.instanceId -and [int]$Status.pid -gt 0)
}

$Release = Invoke-RestMethod -Uri 'https://api.github.com/repos/shuewoung/codesk/releases/latest' -Headers @{ 'User-Agent' = 'CodeskInstaller' } -TimeoutSec 20
$TargetVersion = (ConvertTo-StableVersion $Release.tag_name).ToString()
if ($Release.draft -or $Release.prerelease) { throw '拒绝安装非正式发布版本' }
$Urls = @("https://github.com/shuewoung/codesk/releases/download/$($Release.tag_name)/CodeskHub-windows.zip")
$InstalledPackage = Join-Path $Dest 'hub\package.json'
if (Test-Path -LiteralPath $Dest) {
  if (-not (Test-Path -LiteralPath $InstalledPackage)) { throw '现有安装版本无法确认；未修改安装，请先人工检查。' }
  $InstalledVersion = ConvertTo-StableVersion ((Get-Content -LiteralPath $InstalledPackage -Raw | ConvertFrom-Json).version)
  if ($InstalledVersion -gt (ConvertTo-StableVersion $TargetVersion)) { throw "拒绝降级：$InstalledVersion -> $TargetVersion" }
}
Write-Host "[Codesk] 目标版本 $TargetVersion"

function Write-Step($msg) {
  Write-Host "[Codesk] $msg"
}

function Get-HubZip {
  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
  $headers = @{ "User-Agent" = "CodeskInstaller" }
  $last = $null
  foreach ($url in $Urls) {
    try {
      Write-Step "下载 $url"
      Invoke-WebRequest -Uri $url -OutFile $ZipPath -UseBasicParsing -Headers $headers
      if ((Test-Path -LiteralPath $ZipPath) -and ((Get-Item -LiteralPath $ZipPath).Length -gt 1024)) {
        return
      }
    } catch {
      $last = $_
    }
  }
  throw "下载安装包失败。请打开 https://github.com/shuewoung/codesk/releases 手动下载 CodeskHub-windows.zip。$last"
}

Write-Step "安装 Codesk Hub（托盘，不是 CLI）"
try {
Get-HubZip
Write-Step "解压并验证暂存安装包"
Expand-Archive -LiteralPath $ZipPath -DestinationPath $Stage
foreach ($file in @($ExeName, 'node\node.exe', 'hub\package.json', 'hub\package-lock.json', 'hub\server\index.js', 'hub\public\index.html', 'hub\public\host.html', 'hub\public\favicon-192.png', 'hub\public\icons\codesk-app.png')) {
  $path = Join-Path $Stage $file
  if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
    throw "安装包不完整：缺少 $file；原安装未改变"
  }
}
$PackageVersion = [string](Get-Content -LiteralPath (Join-Path $Stage 'hub\package.json') -Raw | ConvertFrom-Json).version
if ($PackageVersion -cne $TargetVersion) { throw "安装包版本不符：目标 $TargetVersion，实际 $PackageVersion；原安装未改变" }
foreach ($file in @('app.js', 'sw.js')) {
  if (Test-Path -LiteralPath (Join-Path $Stage "hub\public\$file")) { throw "安装包包含旧 PWA，请使用 Expo Web 版本" }
}
& (Join-Path $Stage 'node\node.exe') --check (Join-Path $Stage 'hub\server\index.js')
if ($LASTEXITCODE -ne 0) { throw "安装包 Node/Hub 验证失败；原安装未改变" }
Push-Location (Join-Path $Stage 'hub')
try {
  & (Join-Path $Stage 'node\node.exe') -e "const p=require('./package.json'); for(const name of Object.keys(p.dependencies||{})) require.resolve(name);"
  if ($LASTEXITCODE -ne 0) { throw "安装包依赖不完整；原安装未改变" }
} finally { Pop-Location }

# 拒绝在未知端口实例上覆盖安装；不停止源码或其他目录进程。
foreach ($listener in @(Get-NetTCPConnection -LocalPort 18990 -State Listen -ErrorAction SilentlyContinue)) {
  $owner = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
  if (-not $owner.Path -or $owner.Path -ne (Join-Path $Dest 'node\node.exe')) {
    throw '端口 18990 被未知实例占用；原安装未改变，请人工确认。'
  }
}
# 仅停止目标安装目录中的进程，不碰源码开发实例或其他安装。
Get-Process -Name 'CodeskHub', 'node' -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -and ($_.Path -eq (Join-Path $Dest $ExeName) -or $_.Path -eq (Join-Path $Dest 'node\node.exe'))
} | Stop-Process -Force
Start-Sleep -Milliseconds 400
$hadInstall = Test-Path -LiteralPath $Dest
try {
  if ($hadInstall) { Move-Item -LiteralPath $Dest -Destination $Backup }
  Move-Item -LiteralPath $Stage -Destination $Dest
} catch {
  if ((Test-Path -LiteralPath $Backup) -and -not (Test-Path -LiteralPath $Dest)) {
    Move-Item -LiteralPath $Backup -Destination $Dest
  }
  throw
}
$exe = Join-Path $Dest $ExeName
# 保留旧安装备份，便于启动后人工回滚；用户数据仍在原有用户目录。
if ($hadInstall) { Write-Step "旧安装备份：$Backup" }

$w = New-Object -ComObject WScript.Shell
$desk = [Environment]::GetFolderPath("Desktop")
$sm = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs"
foreach ($dir in @($desk, $sm)) {
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  $lnk = Join-Path $dir "Codesk Hub.lnk"
  $s = $w.CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.WorkingDirectory = $Dest
  $s.IconLocation = "$exe,0"
  $s.Save()
}

Write-Step "启动托盘"
$LaunchId = [Guid]::NewGuid().ToString('N')
$previousLaunchId = $env:CODESK_LAUNCH_ID
try {
  $env:CODESK_LAUNCH_ID = $LaunchId
  $tray = Start-Process -FilePath $exe -WorkingDirectory $Dest -PassThru
} finally { $env:CODESK_LAUNCH_ID = $previousLaunchId }

$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:18990/api/host/status" -TimeoutSec 2
    if (-not $tray.HasExited -and (Test-LaunchStatus $status $LaunchId $TargetVersion)) {
      $up = $true
      break
    }
  } catch { }
}
if ($up) {
  Start-Process "http://127.0.0.1:18990/host"
  Write-Step "已启动。右下角托盘，双击打开主机台。"
} else {
  throw "文件已安装，但未核验到本次启动的 $TargetVersion 实例（launchId=$LaunchId）。可能存在托盘/端口冲突；未停止未知进程。旧备份（如有）：$Backup。请按恢复文档人工检查，不能视为升级成功。"
}

} finally {
  Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
