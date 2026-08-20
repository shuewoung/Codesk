$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Dest = Join-Path $env:LOCALAPPDATA "Programs\Codesk"
$TmpDir = Join-Path $env:TEMP "codesk-hub-install"
$ZipPath = Join-Path $TmpDir "CodeskHub-windows.zip"
$ExeName = "CodeskHub.exe"
$Urls = @(
  "https://codesk.icu/CodeskHub-windows.zip",
  "https://github.com/shuewoung/codesk/releases/latest/download/CodeskHub-windows.zip",
  "https://github.com/shuewoung/codesk/releases/download/v1.0.6/CodeskHub-windows.zip"
)

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
Get-Process -Name "CodeskHub" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 400
Get-HubZip

if (Test-Path -LiteralPath $Dest) {
  Get-ChildItem -LiteralPath $Dest -Force | Remove-Item -Recurse -Force
} else {
  New-Item -ItemType Directory -Path $Dest | Out-Null
}

Write-Step "解压到 $Dest"
Expand-Archive -LiteralPath $ZipPath -DestinationPath $Dest -Force

$exe = Join-Path $Dest $ExeName
if (-not (Test-Path -LiteralPath $exe)) {
  throw "安装包不完整：找不到 $ExeName"
}

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
Start-Process -FilePath $exe -WorkingDirectory $Dest

$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  try {
    $req = [System.Net.WebRequest]::Create("http://127.0.0.1:18990/api/auth/status")
    $req.Timeout = 800
    $resp = $req.GetResponse()
    $resp.Close()
    $up = $true
    break
  } catch { }
}
if ($up) {
  Start-Process "http://127.0.0.1:18990/host"
  Write-Step "已启动。右下角托盘，双击打开主机台。"
} else {
  Write-Step "已安装。若托盘没出现，请从开始菜单打开 Codesk Hub。"
}

Remove-Item -LiteralPath $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
