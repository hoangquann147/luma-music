param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot=Join-Path $project '.build-tools\installer-smoke'
$installDir=Join-Path $testRoot 'installed'
$verifyDir=Join-Path $testRoot 'verified-tools'
$registry='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LumaRust'
if(Test-Path -LiteralPath $registry){throw 'An existing Luma Rust installation is registered. Run this check in a clean environment.'}
New-Item -ItemType Directory -Force $testRoot | Out-Null
$setup=Start-Process -FilePath ([IO.Path]::GetFullPath($Installer)) -ArgumentList @('/S',"/D=$installDir") -WindowStyle Hidden -Wait -PassThru
if($setup.ExitCode -ne 0){throw "Setup exited $($setup.ExitCode)"}
$installed=Get-ItemProperty -LiteralPath $registry
if($installed.DisplayVersion -ne '1.0.0' -or $installed.InstallLocation -ne $installDir){throw 'Installer registry metadata mismatch'}
$exe=Join-Path $installDir 'Luma.exe'
if(!(Test-Path -LiteralPath $exe)){throw 'Installed application is missing'}
$verify=Start-Process -FilePath $exe -ArgumentList @('--verify-package',$verifyDir) -WindowStyle Hidden -Wait -PassThru
if($verify.ExitCode -ne 0){throw "Installed application verification exited $($verify.ExitCode)"}
$package=Get-Content -LiteralPath (Join-Path $verifyDir 'verification.json') -Raw | ConvertFrom-Json
if(!$package.verified -or $package.version -ne '1.0.0'){throw 'Installed application version/integrity check failed'}
$shortcut=Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Luma Rust\Luma.lnk'
if(!(Test-Path -LiteralPath $shortcut)){throw 'Start Menu shortcut was not created'}
$sentinel=Join-Path $installDir 'keep-user-file.txt'
Set-Content -LiteralPath $sentinel -Value 'Uninstall must preserve files it did not install.'
$uninstall=Start-Process -FilePath (Join-Path $installDir 'Uninstall.exe') -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
$deadline=(Get-Date).AddSeconds(30)
while(((Test-Path -LiteralPath $registry) -or (Test-Path -LiteralPath $exe)) -and (Get-Date) -lt $deadline){Start-Sleep -Milliseconds 200}
if((Test-Path -LiteralPath $registry) -or (Test-Path -LiteralPath $exe) -or (Test-Path -LiteralPath $shortcut)){throw 'Uninstaller did not remove its application, shortcut or registry entry'}
if(!(Test-Path -LiteralPath $sentinel)){throw 'Uninstaller removed an unowned file'}
$report=[ordered]@{installer=[IO.Path]::GetFullPath($Installer);version=$package.version;install=$true;packageIntegrity=$true;startMenuShortcut=$true;uninstall=$true;unownedFilesPreserved=$true;userProfileDeleted=$false}
$artifactDir=Split-Path ([IO.Path]::GetFullPath($Installer)) -Parent
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $artifactDir 'INSTALLER-VERIFICATION.json')
$report | ConvertTo-Json
