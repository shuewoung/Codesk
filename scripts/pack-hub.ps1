$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$hubSrc = Join-Path $root "apps\web-hub"
$dist = Join-Path $root "dist"
$work = "C:\Users\zhang\AppData\Local\Temp\opencode\codesk-pack"
$stage = Join-Path $work "payload"
$csc = Join-Path $env:SystemRoot "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$nodeSrc = (Get-Command node -ErrorAction SilentlyContinue).Source

function ConvertTo-BmpIco {
  param([string]$PngPath, [string]$IcoPath, [int[]]$Sizes = @(16, 32, 48))
  Add-Type -AssemblyName System.Drawing
  $src = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $PngPath))
  $frames = New-Object System.Collections.Generic.List[byte[]]
  foreach ($s in $Sizes) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $pad = $(if ($s -ge 24) { 2 } else { 1 })
    $g.DrawImage($src, $pad, $pad, $s - $pad * 2, $s - $pad * 2)
    $g.Dispose()
    $rect = New-Object System.Drawing.Rectangle 0, 0, $s, $s
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $px = New-Object byte[] ($data.Stride * $s)
    [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $px, 0, $px.Length)
    $stride = $data.Stride
    $bmp.UnlockBits($data)
    $bmp.Dispose()
    $xorSize = $s * $s * 4
    $andRow = [int](([Math]::Ceiling($s / 32.0)) * 4)
    $andSize = $andRow * $s
    $dib = New-Object byte[] (40 + $xorSize + $andSize)
    [BitConverter]::GetBytes([int]40).CopyTo($dib, 0)
    [BitConverter]::GetBytes([int]$s).CopyTo($dib, 4)
    [BitConverter]::GetBytes([int]($s * 2)).CopyTo($dib, 8)
    [BitConverter]::GetBytes([int16]1).CopyTo($dib, 12)
    [BitConverter]::GetBytes([int16]32).CopyTo($dib, 14)
    [BitConverter]::GetBytes([int]$xorSize).CopyTo($dib, 20)
    for ($y = 0; $y -lt $s; $y++) {
      [Array]::Copy($px, ($s - 1 - $y) * $stride, $dib, 40 + $y * $s * 4, $s * 4)
    }
    $frames.Add($dib)
  }
  $src.Dispose()
  $count = $frames.Count
  $offset = 6 + 16 * $count
  $ms = New-Object IO.MemoryStream
  $bw = New-Object IO.BinaryWriter $ms
  $bw.Write([int16]0)
  $bw.Write([int16]1)
  $bw.Write([int16]$count)
  foreach ($dib in $frames) {
    $s = [BitConverter]::ToInt32($dib, 4)
    $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
    $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([int16]1)
    $bw.Write([int16]32)
    $bw.Write([int]$dib.Length)
    $bw.Write([int]$offset)
    $offset += $dib.Length
  }
  foreach ($dib in $frames) { $bw.Write($dib) }
  $bw.Flush()
  [IO.File]::WriteAllBytes($IcoPath, $ms.ToArray())
  $bw.Dispose()
  $ms.Dispose()
}

if (-not (Test-Path -LiteralPath $csc)) { throw "找不到 csc.exe" }
if (-not $nodeSrc -or -not (Test-Path -LiteralPath $nodeSrc)) { throw "找不到本机 node.exe，打包需要先有 Node" }

if (-not (Test-Path -LiteralPath (Join-Path $hubSrc "node_modules"))) {
  Push-Location $hubSrc
  try { npm install --omit=dev } finally { Pop-Location }
}

if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $stage "hub") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "node") | Out-Null
if (-not (Test-Path -LiteralPath $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }

Copy-Item -LiteralPath (Join-Path $hubSrc "package.json") -Destination (Join-Path $stage "hub\package.json")
Copy-Item -LiteralPath (Join-Path $hubSrc "server") -Destination (Join-Path $stage "hub\server") -Recurse
Copy-Item -LiteralPath (Join-Path $hubSrc "public") -Destination (Join-Path $stage "hub\public") -Recurse
robocopy (Join-Path $hubSrc "node_modules") (Join-Path $stage "hub\node_modules") /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制 node_modules 失败" }
Copy-Item -LiteralPath $nodeSrc -Destination (Join-Path $stage "node\node.exe")

$hubExe = Join-Path $stage "CodeskHub.exe"
$hubCs = Join-Path $PSScriptRoot "CodeskHub.cs"
$png = Join-Path $hubSrc "public\favicon-192.png"
$ico = Join-Path $work "codesk.ico"
ConvertTo-BmpIco -PngPath $png -IcoPath $ico
Copy-Item -LiteralPath $ico -Destination (Join-Path $stage "favicon.ico") -Force
Copy-Item -LiteralPath $png -Destination (Join-Path $stage "favicon-192.png") -Force
$manifest = Join-Path $PSScriptRoot "CodeskHub.manifest"
& $csc /nologo /target:winexe "/win32icon:$ico" "/win32manifest:$manifest" /r:System.Windows.Forms.dll /r:System.Drawing.dll "/out:$hubExe" $hubCs
if ($LASTEXITCODE -ne 0) { throw "编译 CodeskHub.exe 失败" }

$installCmd = @'
@echo off
set DEST=%LOCALAPPDATA%\Programs\Codesk
if not exist "%DEST%" mkdir "%DEST%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%~dp0payload.zip' -DestinationPath '%DEST%' -Force"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $exe=Join-Path $env:LOCALAPPDATA 'Programs\Codesk\CodeskHub.exe'; $desk=[Environment]::GetFolderPath('Desktop'); $sm=Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'; $s=$w.CreateShortcut((Join-Path $desk 'Codesk Hub.lnk')); $s.TargetPath=$exe; $s.WorkingDirectory=(Split-Path $exe); $s.Save(); $s2=$w.CreateShortcut((Join-Path $sm 'Codesk Hub.lnk')); $s2.TargetPath=$exe; $s2.WorkingDirectory=(Split-Path $exe); $s2.Save()"
start "" "%DEST%\CodeskHub.exe"
'@
Set-Content -LiteralPath (Join-Path $work "install.cmd") -Value $installCmd -Encoding ASCII

$zip = Join-Path $work "payload.zip"
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force

$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=1
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$work\CodeskSetup.exe
FriendlyName=Codesk Hub
AppLaunched=cmd.exe /c install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
FILE0="install.cmd"
FILE1="payload.zip"
[SourceFiles]
SourceFiles0=$work\
[SourceFiles0]
%FILE0%=
%FILE1%=
"@
$sedPath = Join-Path $work "codesk.sed"
Set-Content -LiteralPath $sedPath -Value $sed -Encoding ASCII

$iexpress = Join-Path $env:SystemRoot "System32\iexpress.exe"
$p = Start-Process -FilePath $iexpress -ArgumentList "/N","/Q",$sedPath -Wait -PassThru
if ($p.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $work "CodeskSetup.exe"))) {
  throw "生成 CodeskSetup.exe 失败, exit=$($p.ExitCode)"
}

Copy-Item -LiteralPath (Join-Path $work "CodeskSetup.exe") -Destination (Join-Path $dist "CodeskSetup.exe") -Force
$portableZip = Join-Path $dist "CodeskHub-windows.zip"
if (Test-Path -LiteralPath $portableZip) { Remove-Item -LiteralPath $portableZip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $portableZip -Force
Copy-Item -LiteralPath $portableZip -Destination (Join-Path $dist "CodeskHub-portable.zip") -Force

Get-Item (Join-Path $dist "CodeskSetup.exe"), $portableZip | ForEach-Object { "$($_.FullName) $($_.Length)" }
