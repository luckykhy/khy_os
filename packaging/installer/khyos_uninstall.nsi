; khy-os Windows Uninstaller (NSIS)
; Self-destruct: removes uninstaller + install dir after completion
; Reference: Y-code xingyao-y-code ycode_uninstall.py architecture

!include "MUI2.nsh"
!include "LogicLib.nsh"

; ── Version (injected by build_installer.js) ──
!define VERSION "1.1.15"
!define PRODUCT_NAME "KhyOS"
!define PRODUCT_DIR_REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\khy-os"

; ── General ──
Name "${PRODUCT_NAME} Uninstaller"
OutFile "..\..\dist\releases\khy-os-uninstall.exe"
RequestExecutionLevel highest
ShowInstDetails show
ShowUnInstDetails show

; ── MUI2 Pages ──
!define MUI_ABORTWARNING
!define MUI_UNICON "assets\wizard.ico"

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

; ═══════════════════════════════════════════════════════════════
; Uninstaller Section
; ═══════════════════════════════════════════════════════════════
Section "Uninstall"

  ; ── Safety verification ──
  IfFileExists "$INSTDIR\khy.exe" safety_ok
  IfFileExists "$INSTDIR\_internal\version.txt" safety_ok
  MessageBox MB_OK "Safety check failed: $INSTDIR is not a valid KhyOS installation. Aborting."
  Abort
safety_ok:

  ; ── Detect scope (user vs machine) from registry ──
  ReadRegStr $0 HKLM "${PRODUCT_DIR_REGKEY}" "InstallLocation"
  ${If} $0 == ""
    StrCpy $R0 "user"
  ${Else}
    StrCpy $R0 "machine"
  ${EndIf}

  ; ── Remove desktop shortcuts ──
  Delete "$DESKTOP\KhyOS.lnk"
  Delete "$DESKTOP\KhyOS CLI.lnk"
  Delete "$DESKTOP\KhyOS Desktop.lnk"
  Delete "$DESKTOP\khy.lnk"
  DetailPrint "Removed desktop shortcuts"

  ; ── Remove from HKCU PATH ──
  ReadRegStr $1 HKCU "Environment" "PATH"
  ${If} $1 != ""
    Push $1
    Push "$INSTDIR"
    Call RemoveFromPath
    Pop $1
    WriteRegStr HKCU "Environment" "PATH" "$1"
    DetailPrint "Removed from user PATH"
  ${EndIf}

  ; ── Remove from HKLM PATH (machine scope) ──
  ${If} $R0 == "machine"
    ReadRegStr $1 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
    ${If} $1 != ""
      Push $1
      Push "$INSTDIR"
      Call RemoveFromPath
      Pop $1
      WriteRegStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" "$1"
      DetailPrint "Removed from system PATH"
    ${EndIf}
  ${EndIf}

  ; ── Broadcast WM_SETTINGCHANGE ──
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=1000

  ; ── Remove uninstall registry keys ──
  DeleteRegKey HKCU "${PRODUCT_DIR_REGKEY}"
  DeleteRegKey HKLM "${PRODUCT_DIR_REGKEY}"
  DeleteRegKey HKCU "Software\khy-os"
  DeleteRegKey HKLM "Software\khy-os"
  DetailPrint "Removed registry entries"

  ; ── Remove program files ──
  Delete "$INSTDIR\khy.exe"
  Delete "$INSTDIR\khy-os-uninstall.exe"
  RMDir /r "$INSTDIR\_internal"
  RMDir /r "$INSTDIR\cli"

  ; Try to remove install dir (may fail if non-empty — that's OK)
  RMDir "$INSTDIR"

  DetailPrint "KhyOS uninstall complete"

SectionEnd

; ═══════════════════════════════════════════════════════════════
; Post-uninstall: schedule self-destruct
; ═══════════════════════════════════════════════════════════════
Function un.onGUIEnd
  ; Schedule self-destruct via PowerShell (CREATE_NO_WINDOW, fail-safe)
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$exe=\"$EXEPATH\";$dir=\"$INSTDIR\";for($i=0;$i -lt 40 -and (Test-Path $exe);$i++){Start-Sleep -Milliseconds 250;Remove-Item $exe -Force -ErrorAction SilentlyContinue};if(-not(Test-Path $exe)){[System.IO.Directory]::Delete($dir,$false)}"'
FunctionEnd

; ═══════════════════════════════════════════════════════════════
; Helper: RemoveFromPath — removes $INSTDIR from semicolon-separated PATH
; ═══════════════════════════════════════════════════════════════
Function RemoveFromPath
  Exch $R1  ; item to remove
  Exch
  Exch $R0  ; PATH string
  Push $R2
  Push $R3
  Push $R4

  StrCpy $R2 ""
loop:
  StrCpy $R3 $R0 1 $R4
  ${If} $R3 == ";"
    StrCpy $R3 $R0 $R4
    ${If} $R3 != $R1
      ${If} $R2 == ""
        StrCpy $R2 $R3
      ${Else}
        StrCpy $R2 "$R2;$R3"
      ${EndIf}
    ${EndIf}
    IntOp $R4 $R4 + 1
    StrCpy $R0 $R0 "" $R4
    StrCpy $R4 0
    Goto loop
  ${EndIf}
  ${If} $R3 == ""
    ; End of string — append last segment
    ${If} $R0 != $R1
      ${If} $R2 == ""
        StrCpy $R2 $R0
      ${Else}
        StrCpy $R2 "$R2;$R0"
      ${EndIf}
    ${EndIf}
    StrCpy $R0 $R2
    Goto done
  ${EndIf}
  IntOp $R4 $R4 + 1
  Goto loop
done:
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Push $R0
  Exch $R0
  Exch
  Pop $R0
FunctionEnd
