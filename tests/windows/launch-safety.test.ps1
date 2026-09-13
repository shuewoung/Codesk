# Isolated checks only: never dot-source launchers, download, launch Hub, or stop processes.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$installerPath = Join-Path $root 'apps\www\public\install.ps1'
$sourcePath = Join-Path $root 'scripts\start-web-hub.ps1'
$trayPath = Join-Path $root 'scripts\CodeskHub.cs'
$checks = 0
function Assert($Condition, $Message) {
  if (-not $Condition) { throw "FAIL: $Message" }
  $script:checks++
}
foreach ($path in @($installerPath, $sourcePath)) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
  Assert ($errors.Count -eq 0) "PowerShell parse: $path $errors"
  foreach ($name in @('ConvertTo-StableVersion', 'Test-LaunchStatus', 'Test-SourceLaunchStatus')) {
    $fn = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if ($fn) { . ([scriptblock]::Create($fn.Extent.Text)) }
  }
}
Assert ((ConvertTo-StableVersion 'v1.2.3').ToString() -eq '1.2.3') 'tag normalization'
Assert ((ConvertTo-StableVersion '1.10.0') -gt (ConvertTo-StableVersion '1.9.9')) 'numeric downgrade comparison'
foreach ($invalid in @('latest', '', '1.2', '1.2.3-beta', 'v1.02.3', '../v1.2.3')) {
  $rejected = $false
  try { ConvertTo-StableVersion $invalid | Out-Null } catch { $rejected = $true }
  Assert $rejected "reject invalid version $invalid"
}
$valid = @{ success = $true; hubId = 'hub'; port = 18990; launchId = 'new-launch'; version = '1.2.3'; instanceId = 'instance'; pid = 1234 }
Assert (Test-LaunchStatus ([pscustomobject]$valid) 'new-launch' '1.2.3') 'installer accepts matching identity'
Assert (Test-SourceLaunchStatus ([pscustomobject]$valid) 'new-launch' '1.2.3' 1234 18990) 'source accepts matching identity'
foreach ($case in @(@('launchId', 'old-launch'), @('version', '1.2.2'), @('port', 18991), @('instanceId', ''), @('hubId', ''), @('success', $false), @('pid', 0))) {
  $bad = $valid.Clone(); $bad[$case[0]] = $case[1]
  Assert (-not (Test-LaunchStatus ([pscustomobject]$bad) 'new-launch' '1.2.3')) "installer rejects $($case[0]) mismatch"
  Assert (-not (Test-SourceLaunchStatus ([pscustomobject]$bad) 'new-launch' '1.2.3' 1234 18990)) "source rejects $($case[0]) mismatch"
}
$wrongPid = $valid.Clone(); $wrongPid.pid = 5678
Assert (-not (Test-SourceLaunchStatus ([pscustomobject]$wrongPid) 'new-launch' '1.2.3' 1234 18990)) 'source rejects another child PID'
$installer = Get-Content -LiteralPath $installerPath -Raw
$source = Get-Content -LiteralPath $sourcePath -Raw
$tray = Get-Content -LiteralPath $trayPath -Raw
Assert (-not $installer.Contains('/releases/download/v1.0.10/')) 'no historical fallback'
Assert (-not $installer.Contains('/releases/latest/download/')) 'no mutable latest asset URL'
Assert ($installer.Contains('$PackageVersion -cne $TargetVersion')) 'archive version checked before switch'
Assert ($installer.IndexOf('$PackageVersion -cne $TargetVersion') -lt $installer.IndexOf('Stop-Process')) 'version validation precedes process mutation'
Assert ($installer.Contains('$InstalledVersion -gt (ConvertTo-StableVersion $TargetVersion)')) 'downgrade guarded'
Assert ($installer.Contains('$env:CODESK_LAUNCH_ID = $LaunchId')) 'installer forwards launch ID'
Assert ($source.Contains('$env:CODESK_LAUNCH_ID = $launchId')) 'source forwards launch ID'
Assert ($tray.Contains('psi.EnvironmentVariables["CODESK_LAUNCH_ID"] = launchId')) 'tray forwards launch ID'
Assert ($tray.Contains('launchId, expectedVersion, hubProc.Id)')) 'tray checks child PID'
Assert ($tray.Contains('Environment.ExitCode = 2')) 'mutex conflict nonzero exit'
Assert (-not $tray.Contains('/api/auth/status')) 'tray does not accept anonymous auth health'
Assert ($tray.Contains('https://hub.codesk.icu:8787')) 'HTTPS relay default'
Assert (-not $source.Contains('already running')) 'existing service not treated as new launch'

# Compile with the same framework references as pack-hub, without touching dist.
$temp = Join-Path ([IO.Path]::GetTempPath()) ('codesk-launch-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  $exe = Join-Path $temp 'CodeskHub.exe'
  & $csc /nologo /target:winexe /r:System.Windows.Forms.dll /r:System.Drawing.dll "/out:$exe" $trayPath
  Assert ($LASTEXITCODE -eq 0) 'tray compiles with packaging references'
  # Load bytes only; never invoke Main or create a tray/process.
  $assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($exe))
  $parse = $assembly.GetType('CodeskHub').GetMethod('ParseJson', [Reflection.BindingFlags]'NonPublic,Static')
  $parsed = $parse.Invoke($null, [object[]]@('{"version":"1.2.3","launchId":"new-launch","pid":1234,"success":true}'))
  Assert ($parsed['version'] -eq '1.2.3' -and $parsed['pid'] -eq 1234 -and $parsed['success'] -eq $true) 'framework JSON parser preserves typed identity'
  $matches = $assembly.GetType('CodeskHub').GetMethod('MatchesHubStatus', [Reflection.BindingFlags]'NonPublic,Static')
  Assert ($matches.Invoke($null, [object[]]@([string]($valid | ConvertTo-Json -Compress), 'new-launch', '1.2.3', 1234))) 'tray accepts exact launched identity'
  foreach ($case in @(@('launchId', 'old-launch'), @('version', '1.2.2'), @('pid', 5678), @('port', 18991), @('instanceId', ''), @('hubId', ''), @('success', $false))) {
    $bad = $valid.Clone(); $bad[$case[0]] = $case[1]
    Assert (-not $matches.Invoke($null, [object[]]@([string]($bad | ConvertTo-Json -Compress), 'new-launch', '1.2.3', 1234))) "tray rejects $($case[0]) mismatch"
  }
  foreach ($json in @('{}', 'null', 'not json', '{"success":true}')) {
    Assert (-not $matches.Invoke($null, [object[]]@($json, 'new-launch', '1.2.3', 1234))) 'tray rejects incomplete or malformed status'
  }
} finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
Write-Output "PASS: $checks isolated launch safety checks"
