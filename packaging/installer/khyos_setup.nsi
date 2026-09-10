; khy-os Windows Installer (NSIS MUI2)
; Classic wizard: Welcome → Scope → Options → Installing → Finish
; Reference: Y-code xingyao-y-code ycode_setup.py architecture

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

; ── Version (injected by build_installer.js) ──
!define VERSION "1.1.15"
!define PRODUCT_NAME "KhyOS"
!define PRODUCT_PUBLISHER "khy-os"
!define PRODUCT_DIR_REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\khy-os"
!define INSTALL_MARKER "KhyOS"

; ── General ──
Name "${PRODUCT_NAME} ${VERSION}"
OutFile "..\..\dist\releases\khy-os_setup_v${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\khy-os"
InstallDirRegKey HKCU "Software\khy-os" "InstallDir"
RequestExecutionLevel highest

; ── MUI2 Pages ──
!define MUI_ABORTWARNING
!define MUI_ICON "assets\wizard.ico"
!define MUI_UNICON "assets\wizard.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "assets\header.bmp"
!define MUI_HEADERIMAGE_RIGHT

; Welcome page
!insertmacro MUI_PAGE_WELCOME

; Scope selection (user / machine)
!define MUI_PAGE_HEADER_SUBTEXT "Choose whether to install for all users or just yourself."
!define MUI_PAGE_CUSTOMFUNCTION_PRE scope_page_pre
!insertmacro MUI_PAGE_COMPONENTS
Page custom scope_page_create scope_page_leave

; Options page (install dir + checkboxes)
!define MUI_PAGE_HEADER_SUBTEXT "Choose install location and options."
!define MUI_PAGE_CUSTOMFUNCTION_PRE options_page_pre
!insertmacro MUI_PAGE_DIRECTORY
Page custom options_page_create options_page_leave

; Installing page
!insertmacro MUI_PAGE_INSTFILES

; Finish page
!define MUI_FINISHPAGE_RUN "$INSTDIR\khy.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "--version"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT
!insertmacro MUI_PAGE_FINISH

; ── Uninstaller pages ──
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; ── Languages ──
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

; ── Reserve files ──
!insertmacro MUI_RESERVEFILE_LANGDLL

; ── Installer variables ──
Var Dialog
Var ScopeSelection
Var ScopeUserRadio
Var ScopeMachineRadio
Var InstallCliCheckbox
Var CreateShortcutCheckbox
Var InstallCliState
Var CreateShortcutState

; ═══════════════════════════════════════════════════════════════
; Scope Selection Page (user / machine)
; ═══════════════════════════════════════════════════════════════
Function scope_page_create
  ; Check if re-launching elevated for machine install
  ${If} ${Cmd} `MessageBox MB_OK "elevated"`
    Abort
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Select Installation Scope" "Choose who should have access to KhyOS."

  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ${NSD_CreateGroupBox} 0 0 100% 80% "Installation scope"
  Pop $0

  ${NSD_CreateRadioButton} 10% 20% 80% 12% "Install for me only (recommended)"
  Pop $ScopeUserRadio
  ${NSD_SetState} $ScopeUserRadio 1

  ${NSD_CreateRadioButton} 10% 40% 80% 12% "Install for all users (requires admin)"
  Pop $ScopeMachineRadio

  ${NSD_CreateLabel} 12% 55% 76% 20% "All-user install requires administrator privileges (UAC prompt).$\r$\nDefault location: %ProgramFiles%\khy-os"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function scope_page_leave
  ${NSD_GetState} $ScopeUserRadio $0
  ${If} $0 == 1
    StrCpy $ScopeSelection "user"
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\khy-os"
  ${Else}
    StrCpy $ScopeSelection "machine"
    StrCpy $INSTDIR "$PROGRAMFILES64\khy-os"
  ${EndIf}
FunctionEnd

Function scope_page_pre
FunctionEnd

; ═══════════════════════════════════════════════════════════════
; Options Page (install CLI, create shortcut)
; ═══════════════════════════════════════════════════════════════
Function options_page_create
  !insertmacro MUI_HEADER_TEXT "Installation Options" "Configure additional installation options."

  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ${NSD_CreateGroupBox} 0 0 100% 80% "Options"

  ${NSD_CreateCheckbox} 10% 20% 80% 12% "Create desktop shortcut"
  Pop $CreateShortcutCheckbox
  ${NSD_SetState} $CreateShortcutCheckbox 1

  ${NSD_CreateCheckbox} 10% 40% 80% 12% "Add to PATH (use 'khy' in terminal)"
  Pop $InstallCliCheckbox
  ${NSD_SetState} $InstallCliCheckbox 1

  nsDialogs::Show
FunctionEnd

Function options_page_leave
  ${NSD_GetState} $InstallCliCheckbox $InstallCliState
  ${NSD_GetState} $CreateShortcutCheckbox $CreateShortcutState
FunctionEnd

Function options_page_pre
FunctionEnd

; ═══════════════════════════════════════════════════════════════
; Install Sections
; ═══════════════════════════════════════════════════════════════

Section "KhyOS Core" SEC_CORE
  SectionIn RO

  ; Check for elevation if machine scope
  ${If} $ScopeSelection == "machine"
    UserInfo::GetAccountType
    Pop $0
    ${If} $0 != "Admin"
      ; Relaunch elevated
      ExecShell "runas" '"$EXEPATH"' '/S /D=$INSTDIR /elevated=1 /scope=machine /cli=$InstallCliState /shortcut=$CreateShortcutState'
      Quit
    ${EndIf}
  ${EndIf}

  SetOutPath "$INSTDIR"

  ; Extract payload zip
  File "payload\khy-pkg.zip"
  nsisunz::Unzip "$INSTDIR\khy-pkg.zip" "$INSTDIR\"
  Pop $0
  DetailPrint "Extracting payload... $0"
  Delete "$INSTDIR\khy-pkg.zip"

  ; Write install manifest
  FileOpen $0 "$INSTDIR\_internal\khy_install_manifest.txt" w
  FileWrite $0 "khy-pkg.zip extracted\r\n"
  FileClose $0

SectionEnd

Section "Add to PATH" SEC_PATH
  ${If} $InstallCliState == 1
    ${If} $ScopeSelection == "machine"
      ; Write to HKLM system PATH
      ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
      ${If} $0 == ""
        StrCpy $0 "$INSTDIR"
      ${Else}
        ; Check if already present
        Push $0
        Push "$INSTDIR"
        Call StrStr
        Pop $1
        ${If} $1 == ""
          StrCpy $0 "$0;$INSTDIR"
        ${EndIf}
      ${EndIf}
      WriteRegStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" "$0"
    ${Else}
      ; Write to HKCU user PATH
      ReadRegStr $0 HKCU "Environment" "PATH"
      ${If} $0 == ""
        StrCpy $0 "$INSTDIR"
      ${Else}
        Push $0
        Push "$INSTDIR"
        Call StrStr
        Pop $1
        ${If} $1 == ""
          StrCpy $0 "$0;$INSTDIR"
        ${EndIf}
      ${EndIf}
      WriteRegStr HKCU "Environment" "PATH" "$0"
    ${EndIf}

    ; Broadcast WM_SETTINGCHANGE
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=1000
    DetailPrint "Added to PATH"
  ${EndIf}
SectionEnd

Section "Desktop Shortcut" SEC_SHORTCUT
  ${If} $CreateShortcutState == 1
    ${If} $ScopeSelection == "machine"
      CreateShortcut "$DESKTOP\KhyOS.lnk" "$INSTDIR\khy.exe" "" "$INSTDIR\khy.exe"
    ${Else}
      CreateShortcut "$DESKTOP\KhyOS.lnk" "$INSTDIR\khy.exe" "" "$INSTDIR\khy.exe"
    ${EndIf}
    DetailPrint "Created desktop shortcut"
  ${EndIf}
SectionEnd

Section -PostInstall
  ; Write uninstaller
  WriteUninstaller "$INSTDIR\khy-os-uninstall.exe"

  ; Write uninstall registry
  ${If} $ScopeSelection == "machine"
    WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "DisplayName" "KhyOS"
    WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "UninstallString" '"$INSTDIR\khy-os-uninstall.exe"'
    WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "DisplayIcon" '"$INSTDIR\khy.exe"'
    WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "Publisher" "${PRODUCT_PUBLISHER}"
    WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "KhyOSInstallMarker" "${INSTALL_MARKER}"
    WriteRegDWORD HKLM "${PRODUCT_DIR_REGKEY}" "NoModify" 1
    WriteRegDWORD HKLM "${PRODUCT_DIR_REGKEY}" "NoRepair" 1
    WriteRegStr HKCU "Software\khy-os" "InstallDir" "$INSTDIR"
  ${Else}
    WriteRegStr HKCU "${PRODUCT_DIR_REGKEY}" "DisplayName" "KhyOS"
    WriteRegStr HKCU "${PRODUCT_DIR_REGKEY}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "${PRODUCT_DIR_REGKEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${PRODUCT_DIR_REGKEY}" "UninstallString" '"$INSTDIR\khy-os-uninstall.exe"'
    WriteRegStr HKCU "${PRODUCT_DIR_REGKEY}" "DisplayIcon" '"$INSTDIR\khy.exe"'
    WriteRegStr HKCU "${PRODUCT_DIR_REGKEY}" "Publisher" "${PRODUCT_PUBLISHER}"
    WriteRegStr HKCU "${PRODUCT_DIR_REGKEY}" "KhyOSInstallMarker" "${INSTALL_MARKER}"
    WriteRegDWORD HKCU "${PRODUCT_DIR_REGKEY}" "NoModify" 1
    WriteRegDWORD HKCU "${PRODUCT_DIR_REGKEY}" "NoRepair" 1
    WriteRegStr HKCU "Software\khy-os" "InstallDir" "$INSTDIR"
  ${EndIf}

  DetailPrint "Installation complete"
SectionEnd

; ═══════════════════════════════════════════════════════════════
; Section descriptions
; ═══════════════════════════════════════════════════════════════
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CORE} "KhyOS core files (required)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_PATH} "Add khy command to system PATH"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_SHORTCUT} "Create desktop shortcut"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ═══════════════════════════════════════════════════════════════
; Uninstaller
; ═══════════════════════════════════════════════════════════════
Section "Uninstall"
  ; Verify this is a real khy-os install
  IfFileExists "$INSTDIR\khy.exe" install_verified
  IfFileExists "$INSTDIR\_internal\version.txt" install_verified
  MessageBox MB_OK "Safety check failed: $INSTDIR does not appear to be a KhyOS install directory. Aborting."
  Abort
install_verified:

  ; Remove desktop shortcuts
  Delete "$DESKTOP\KhyOS.lnk"
  Delete "$DESKTOP\KhyOS CLI.lnk"
  Delete "$DESKTOP\KhyOS Desktop.lnk"

  ; Remove from PATH
  ReadRegStr $0 HKCU "Environment" "PATH"
  ${If} $0 != ""
    Push $0
    Push "$INSTDIR"
    Call RemoveFromPath
    Pop $0
    WriteRegStr HKCU "Environment" "PATH" "$0"
  ${EndIf}

  ; Check machine scope
  ReadRegStr $0 HKLM "${PRODUCT_DIR_REGKEY}" "InstallLocation"
  ${If} $0 != ""
    ; Also clean HKLM PATH
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
    ${If} $0 != ""
      Push $0
      Push "$INSTDIR"
      Call RemoveFromPath
      Pop $0
      WriteRegStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" "$0"
    ${EndIf}

    ; Remove HKLM uninstall registry
    DeleteRegKey HKLM "${PRODUCT_DIR_REGKEY}"
    DeleteRegKey HKLM "Software\khy-os"
  ${EndIf}

  ; Remove HKCU uninstall registry
  DeleteRegKey HKCU "${PRODUCT_DIR_REGKEY}"
  DeleteRegKey HKCU "Software\khy-os"

  ; Broadcast environment change
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=1000

  ; Remove program files
  Delete "$INSTDIR\khy.exe"
  Delete "$INSTDIR\khy-os-uninstall.exe"
  RMDir /r "$INSTDIR\_internal"
  RMDir /r "$INSTDIR\cli"

  ; Try to remove install dir (may fail if non-empty)
  RMDir "$INSTDIR"

SectionEnd

; ═══════════════════════════════════════════════════════════════
; Helper: RemoveFromPath — removes $INSTDIR from semicolon PATH
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

; ═══════════════════════════════════════════════════════════════
; Helper: StrStr — find substring in string
; ═══════════════════════════════════════════════════════════════
Function StrStr
  Exch $R1  ; substring
  Exch
  Exch $R0  ; string
  Push $R2
  Push $R3
  Push $R4

  StrCpy $R3 -1
  StrLen $R4 $R1
  StrCpy $R2 0

loop:
  StrCpy $R3 $R0 $R4 $R2
  StrCmp $R3 "" done
  StrCmp $R3 $R1 done
  IntOp $R2 $R2 + 1
  Goto loop

done:
  StrCpy $R0 $R2
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd
