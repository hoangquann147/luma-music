param(
  [Parameter(Mandatory = $true)][string]$PayloadPath,
  [Parameter(Mandatory = $true)][string]$SevenZipPath,
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\release\Luma.exe'),
  [string]$ScratchPath = (Join-Path $PSScriptRoot '..\.portable-build')
)
$ErrorActionPreference = 'Stop'
$appVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json).version
if ($appVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid portable package version.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The Windows .NET Framework x64 C# compiler is unavailable.' }
$payload = (Resolve-Path -LiteralPath $PayloadPath).Path
$sevenZip = (Resolve-Path -LiteralPath $SevenZipPath).Path
$sevenZipRoot = Split-Path -Parent (Split-Path -Parent $sevenZip)
$license = Join-Path $sevenZipRoot 'LICENSE.txt'
$copying = Join-Path $sevenZipRoot 'COPYING'
foreach ($file in @($license, $copying)) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing 7-Zip license: $file" } }
$redistributedLicenses = Join-Path $PSScriptRoot '..\build\launcher-licenses'
New-Item -ItemType Directory -Path $redistributedLicenses -Force | Out-Null
Copy-Item -LiteralPath $license -Destination (Join-Path $redistributedLicenses '7zip-LICENSE.txt') -Force
Copy-Item -LiteralPath $copying -Destination (Join-Path $redistributedLicenses '7zip-COPYING.txt') -Force
$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\build\PortableLauncher.cs')).Path
$icon = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\build\icon.ico')).Path
$output = [System.IO.Path]::GetFullPath($OutputPath)
$scratch = [System.IO.Path]::GetFullPath($ScratchPath)
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
$manifest = Join-Path $scratch 'package-manifest.txt'
$payloadHash = (Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash.ToLowerInvariant()
$sevenZipHash = (Get-FileHash -LiteralPath $sevenZip -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText($manifest, "Version=$appVersion`nPayloadSha256=$payloadHash`nSevenZipSha256=$sevenZipHash`n", (New-Object System.Text.UTF8Encoding($false)))
$applicationManifest = Join-Path $scratch 'launcher.manifest'
$manifestText = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="__LUMA_VERSION__.0" processorArchitecture="amd64" name="Luma.Portable" type="win32" />
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false" /></requestedPrivileges></security></trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" /></application></compatibility>
</assembly>
'@
[System.IO.File]::WriteAllText($applicationManifest, $manifestText.Replace('__LUMA_VERSION__', $appVersion), (New-Object System.Text.UTF8Encoding($false)))
$arguments = @(
  '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/debug-',
  '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Windows.Forms.dll',
  "/out:$output", "/win32icon:$icon", "/win32manifest:$applicationManifest",
  "/resource:$payload,Luma.Payload.7z", "/resource:$sevenZip,Luma.SevenZip.exe",
  "/resource:$license,Luma.SevenZip.LICENSE.txt", "/resource:$copying,Luma.SevenZip.COPYING",
  "/resource:$manifest,Luma.PackageManifest", $source
)
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw "C# compiler failed with exit code $LASTEXITCODE" }
$result = Get-Item -LiteralPath $output
Write-Output ([PSCustomObject]@{ Path = $result.FullName; Bytes = $result.Length; SHA256 = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant() })
