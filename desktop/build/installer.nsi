Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!ifndef APP_VERSION
  !define APP_VERSION "1.0.0"
!endif
!define APP_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\LumaRust"
!define WEBVIEW_KEY "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
Name "Luma Rust"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Luma Rust"
InstallDirRegKey HKCU "${APP_KEY}" "InstallLocation"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "Luma Rust"
VIAddVersionKey "FileDescription" "Luma Rust Windows Setup"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "Luma contributors"
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Luma.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${APP_LICENSE}"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  SetShellVarContext current
  SetRegView 64
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Luma Rust requires 64-bit Windows."
    Abort
  ${EndIf}
FunctionEnd

Function HasWebView2
  SetRegView 32
  ReadRegStr $0 HKLM "${WEBVIEW_KEY}" "pv"
  ${If} $0 != ""
  ${AndIf} $0 != "0.0.0.0"
    StrCpy $0 1
    SetRegView 64
    Return
  ${EndIf}
  ReadRegStr $0 HKCU "${WEBVIEW_KEY}" "pv"
  ${If} $0 != ""
  ${AndIf} $0 != "0.0.0.0"
    StrCpy $0 1
    SetRegView 64
    Return
  ${EndIf}
  SetRegView 64
  ReadRegStr $0 HKCU "${WEBVIEW_KEY}" "pv"
  ${If} $0 != ""
  ${AndIf} $0 != "0.0.0.0"
    StrCpy $0 1
    Return
  ${EndIf}
  StrCpy $0 0
FunctionEnd

Section "Luma Rust (required)" MainSection
  SectionIn RO
  Call HasWebView2
  ${If} $0 == 0
    InitPluginsDir
    File /oname=$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe "${WEBVIEW_SETUP}"
    DetailPrint "Installing Microsoft WebView2 Runtime (Internet required)..."
    ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install' $1
    Call HasWebView2
    ${If} $0 != 1
      MessageBox MB_ICONSTOP "WebView2 Runtime could not be installed. Connect to the Internet, install Microsoft WebView2 Runtime, then run Luma Setup again."
      SetErrorLevel 1
      Abort
    ${EndIf}
  ${EndIf}
  SetOutPath "$INSTDIR"
  File /oname=Luma.exe "${APP_EXE}"
  File /oname=LICENSE.txt "${APP_LICENSE}"
  File /oname=THIRD-PARTY-NOTICES.md "${APP_NOTICES}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${APP_KEY}" "DisplayName" "Luma Rust"
  WriteRegStr HKCU "${APP_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${APP_KEY}" "Publisher" "Luma contributors"
  WriteRegStr HKCU "${APP_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${APP_KEY}" "DisplayIcon" "$INSTDIR\Luma.exe"
  WriteRegStr HKCU "${APP_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "${APP_KEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegStr HKCU "${APP_KEY}" "URLInfoAbout" "https://github.com/hoangquann147/luma-music"
  WriteRegDWORD HKCU "${APP_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${APP_KEY}" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\Luma Rust"
  CreateShortcut "$SMPROGRAMS\Luma Rust\Luma.lnk" "$INSTDIR\Luma.exe"
  CreateShortcut "$SMPROGRAMS\Luma Rust\Uninstall Luma.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section /o "Desktop shortcut" DesktopSection
  CreateShortcut "$DESKTOP\Luma Rust.lnk" "$INSTDIR\Luma.exe"
  WriteRegDWORD HKCU "${APP_KEY}" "DesktopShortcut" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  ReadRegDWORD $0 HKCU "${APP_KEY}" "DesktopShortcut"
  ${If} $0 == 1
    Delete "$DESKTOP\Luma Rust.lnk"
  ${EndIf}
  Delete "$SMPROGRAMS\Luma Rust\Luma.lnk"
  Delete "$SMPROGRAMS\Luma Rust\Uninstall Luma.lnk"
  RMDir "$SMPROGRAMS\Luma Rust"
  Delete "$INSTDIR\Luma.exe"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\THIRD-PARTY-NOTICES.md"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${APP_KEY}"
  ; Deliberately preserve %APPDATA%\Luma-Rust and every music/source directory.
SectionEnd
