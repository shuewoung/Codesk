$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
$hubDir = Join-Path $root "apps\web-hub"
$iconPath = Join-Path $hubDir "public\favicon-192.png"
$hostUrl = "http://127.0.0.1:18990/host"
$appUrl = "http://127.0.0.1:18990/"
$startupName = "Codesk Hub.lnk"
$startupPath = Join-Path ([Environment]::GetFolderPath("Startup")) $startupName

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $guess = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\node\node.exe"
  )
  foreach ($p in $guess) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}

function Test-HubUp {
  try {
    $req = [System.Net.WebRequest]::Create("http://127.0.0.1:18990/api/auth/status")
    $req.Timeout = 800
    $resp = $req.GetResponse()
    $resp.Close()
    return $true
  } catch {
    return $false
  }
}

function Start-Hub {
  if (Test-HubUp) { return }
  $node = Find-Node
  if (-not $node) {
    [System.Windows.Forms.MessageBox]::Show("找不到 node。请先安装 Node.js 22 LTS，并确保能在命令行运行 node。", "Codesk") | Out-Null
    return
  }
  if (-not (Test-Path -LiteralPath (Join-Path $hubDir "node_modules"))) {
    Start-Process -FilePath "npm" -ArgumentList "install" -WorkingDirectory $hubDir -WindowStyle Hidden -Wait
  }
  if (-not $env:ONEDESK_RELAY_URL -and -not $env:CODESK_RELAY_URL) {
    $env:ONEDESK_RELAY_URL = "https://hub.codesk.icu:8787"
  }
  Start-Process -FilePath $node -ArgumentList "server/index.js" -WorkingDirectory $hubDir -WindowStyle Hidden
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 300
    if (Test-HubUp) { return }
  }
}

function Open-HostConsole {
  Start-Hub
  Start-Process $hostUrl
}

function Test-AutoStart {
  return Test-Path -LiteralPath $startupPath
}

function Set-AutoStart([bool]$on) {
  if ($on) {
    $w = New-Object -ComObject WScript.Shell
    $sc = $w.CreateShortcut($startupPath)
    $sc.TargetPath = Join-Path $PSScriptRoot "start-hub-tray.cmd"
    $sc.WorkingDirectory = $PSScriptRoot
    $sc.WindowStyle = 7
    $sc.Save()
  } elseif (Test-Path -LiteralPath $startupPath) {
    Remove-Item -LiteralPath $startupPath -Force
  }
}

Start-Hub

function New-TrayIcon([string]$png) {
  $src = [System.Drawing.Bitmap]::FromFile($png)
  $bmp = New-Object System.Drawing.Bitmap 16, 16, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, 1, 1, 14, 14)
  $g.Dispose()
  $src.Dispose()
  $ms = New-Object IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $h = ([System.Drawing.Bitmap]::FromStream($ms)).GetHicon()
  return [System.Drawing.Icon]::FromHandle($h)
}

$notify = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path -LiteralPath $iconPath) {
  $notify.Icon = New-TrayIcon $iconPath
} else {
  $notify.Icon = [System.Drawing.SystemIcons]::Application
}
$notify.Text = "Codesk Hub"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5)
$menu.ShowImageMargin = $false
$menu.ShowCheckMargin = $true
$menu.Padding = New-Object System.Windows.Forms.Padding 4, 6, 4, 6
$header = New-Object System.Windows.Forms.ToolStripLabel "Codesk Hub"
$header.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5, [System.Drawing.FontStyle]::Bold)
$header.Padding = New-Object System.Windows.Forms.Padding 10, 8, 12, 2
[void]$menu.Items.Add($header)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$workItem = $menu.Items.Add("打开工作台")
$openItem = $menu.Items.Add("打开主机台")
$autoItem = New-Object System.Windows.Forms.ToolStripMenuItem("开机自启动")
$autoItem.Checked = Test-AutoStart
[void]$menu.Items.Add($autoItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exitItem = $menu.Items.Add("退出")
$notify.ContextMenuStrip = $menu

$workItem.add_Click({ Start-Hub; Start-Process $appUrl })
$openItem.add_Click({ Open-HostConsole })
$notify.add_MouseUp({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Start-Hub; Start-Process $appUrl }
})
$autoItem.add_Click({
  $next = -not (Test-AutoStart)
  Set-AutoStart $next
  $autoItem.Checked = $next
})
$exitItem.add_Click({
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

[System.Windows.Forms.Application]::Run()
