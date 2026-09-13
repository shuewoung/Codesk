param(
  [switch]$Restart
)

$ErrorActionPreference = "Stop"
$hubDir = (Resolve-Path (Join-Path $PSScriptRoot "..\apps\web-hub")).Path
$entry = Join-Path $hubDir "server\index.js"
$port = if ($env:PORT) { [int]$env:PORT } else { 18990 }
$origin = "http://127.0.0.1:$port"
$launchId = [Guid]::NewGuid().ToString('N')
$expectedVersion = [string](Get-Content -LiteralPath (Join-Path $hubDir 'package.json') -Raw | ConvertFrom-Json).version
if (-not $expectedVersion) { throw '源码 package.json 缺少版本' }
$logDir = Join-Path $hubDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "hub.out"
$errLog = Join-Path $logDir "hub.err"

function Get-HubNodes {
  # Match only this repository's absolute entry, never another server/index.js.
  $escaped = [regex]::Escape($entry.Replace('\', '/'))
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and $_.CommandLine -and
      ($_.CommandLine.Replace('\', '/') -match ('(?:^|["\s])' + $escaped + '(?:["\s]|$)'))
  }
}

function Test-HubListen {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Test-SourceLaunchStatus($Status, [string]$LaunchId, [string]$Version, [int]$ExpectedPid, [int]$ExpectedPort) {
  return ($Status.success -eq $true -and [bool]$Status.hubId -and $Status.port -eq $ExpectedPort -and
    $Status.launchId -ceq $LaunchId -and $Status.version -ceq $Version -and
    [bool]$Status.instanceId -and $Status.pid -eq $ExpectedPid)
}

function Test-HubHealth {
  try {
    $status = Invoke-RestMethod -Uri "$origin/api/host/status" -TimeoutSec 2
    return (Test-SourceLaunchStatus $status $launchId $expectedVersion $process.Id $port)
  } catch { return $false }
}

function Start-HubHidden {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { throw "node not found" }
  if (-not $env:ONEDESK_RELAY_URL -and -not $env:CODESK_RELAY_URL) {
    $env:ONEDESK_RELAY_URL = "https://hub.codesk.icu:8787"
  }
  $previousLaunchId = $env:CODESK_LAUNCH_ID
  try {
    $env:CODESK_LAUNCH_ID = $launchId
    Start-Process -FilePath $nodeCmd.Source -ArgumentList ('"' + $entry + '"') -WorkingDirectory $hubDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  } finally { $env:CODESK_LAUNCH_ID = $previousLaunchId }
}

if ($Restart) {
  Get-HubNodes | ForEach-Object {
    $procId = [int]$_.ProcessId
    if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { continue }
    Write-Output ("[Codesk] stopping pid={0} (process tree)" -f $procId)
    # 树杀 node 及其 codex 子进程：仅杀 node 会留下孤儿 codex.exe 继续持有写锁。
    # taskkill 失败时退回单进程强杀兜底。
    taskkill /PID $procId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Output ("[Codesk] taskkill exit={0}, fallback Stop-Process pid={1}" -f $LASTEXITCODE, $procId)
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
  }
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline -and (Test-HubListen)) { Start-Sleep -Milliseconds 150 }
}
# A healthy existing endpoint is not evidence of this launch. Require an
# explicit -Restart for processes whose absolute entry belongs to this checkout.
if (Test-HubListen) {
  throw "端口 $port 已占用；未终止未知进程或旧的相对路径启动实例，请确认后手动关闭。"
}

if (-not (Test-Path -LiteralPath (Join-Path $hubDir "node_modules"))) {
  Write-Output "[Codesk] npm ci..."
  Push-Location $hubDir
  try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "安装 Hub 依赖失败" }
  } finally { Pop-Location }
}

$process = Start-HubHidden
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  if ($process.HasExited) { break }
  if (Test-HubHealth) { $ok = $true; break }
}
if (-not $ok) {
  Write-Output ("[Codesk] health check failed; see {0}" -f $errLog)
  exit 1
}
Write-Output "[Codesk] background  $origin"
Write-Output ("[Codesk] logs  {0}" -f $outLog)
