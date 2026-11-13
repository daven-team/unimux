; unimux 1.2.0 installer hooks (Tauri NSIS template, bundle.windows.nsis.installerHooks). PLAN U3, ARCHITECTURE section 8.
;
; Electron 1.1.x updates itself into 1.2.0 through latest.yml: its electron-updater runs this installer as
;   unimux-Setup-1.2.0.exe --updated /S --force-run
; from its detached update window. These hooks make that hand-over keep everything the user had:
;   PREINSTALL  - the Electron install dir (default %LOCALAPPDATA%\Programs\unimux or the user's own folder) stays the
;                 install dir, so pins, shortcuts and the 1.1.x window's `appExe` keep pointing at unimux.exe;
;               - the old unimux.exe processes get up to 30 s to end on their own (the Electron wind-down saves state.json)
;                 before the template's Restart Manager check would force them;
;               - the Electron uninstaller runs silently, keeping the app data and the shortcuts, so only one entry stays
;                 in Apps & features; when it cannot run, its registry keys and its known files are removed by hand.
;   POSTINSTALL - `installer-done` for the update window (port of resources/installer.nsh), the AppUserModelID
;                 com.unimux.app stamped on the existing Start menu / desktop / taskbar pin shortcuts, and the
;                 `--force-run` launch electron-updater asks for.
;
; The Tauri -> Tauri update window runs `/S /UPDATE --updated /D=<installDir>`: it gets `installer-done` and the AUMID
; stamp too, but no launch (the window starts the new app itself).
;
; Only the product `unimux` runs them: the harness payloads (scripts/verify-update-*.mjs, productName unimux-u1 / unimux-u2)
; must never adopt the real Electron install or write into the real %APPDATA%.
;
; Nothing here deletes user data: the data dir (%APPDATA%\unimux or the legacy %APPDATA%\ajzakomator) is never touched
; except for the `update\installer-done` marker, and the hand deletion only names files of the Electron runtime.

!define UNIMUX_ELECTRON_GUID "214279c4-b798-5d4e-848f-0b9245114cd1"
!define UNIMUX_ELECTRON_KEY "Software\${UNIMUX_ELECTRON_GUID}"
!define UNIMUX_ELECTRON_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNIMUX_ELECTRON_GUID}"
!define UNIMUX_ELECTRON_UNINSTALLER "Uninstall unimux.exe"
!define UNIMUX_TASKBAR_PIN "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${PRODUCTNAME}.lnk"
!define /ifndef ERROR_MORE_DATA 234

Var UnimuxElectronDir
; An Electron 1.1.x install for all users (HKLM) and whether it had a desktop shortcut for all users.
Var UnimuxMachineDir
Var UnimuxMachineDesktop

; Waits (up to 60 x 500 ms) until no process runs `exePath`, using the same Restart Manager query as the template's
; CheckIfAppIsRunning (every Electron process of 1.1.x, renderers and GPU included, runs from unimux.exe).
!macro UNIMUX_WAIT_FOR_EXIT exePath
  StrCpy $R9 0
  ${Do}
    StrCpy $R8 0
    !insertmacro RestartManager_StartSession $R7
    ${If} $R7 != ""
      !insertmacro RestartManager_RegisterFile $R7 "${exePath}"
      ${If} $0 = 0
        System::Call 'RSTRTMGR::RmGetList(i R7, *i .r1, *i .r2, p 0, *i .r3) i .r0'
        ${If} $0 = ${ERROR_MORE_DATA}
          StrCpy $R8 1
        ${EndIf}
      ${EndIf}
      !insertmacro RestartManager_EndSession $R7
    ${EndIf}
    ${If} $R8 = 0
      ${Break}
    ${EndIf}
    ${If} $R9 >= 60
      ${Break}
    ${EndIf}
    Sleep 500
    IntOp $R9 $R9 + 1
  ${Loop}
!macroend

; The files an Electron 45 build of unimux 1.1.x installs. Only these go when its uninstaller could not run: the install dir
; may be a folder the user chose, so it is never removed as a whole.
!macro UNIMUX_REMOVE_ELECTRON_FILES dir
  Delete "${dir}\chrome_100_percent.pak"
  Delete "${dir}\chrome_200_percent.pak"
  Delete "${dir}\d3dcompiler_47.dll"
  Delete "${dir}\dxcompiler.dll"
  Delete "${dir}\dxil.dll"
  Delete "${dir}\ffmpeg.dll"
  Delete "${dir}\icudtl.dat"
  Delete "${dir}\libEGL.dll"
  Delete "${dir}\libGLESv2.dll"
  Delete "${dir}\LICENSE.electron.txt"
  Delete "${dir}\LICENSES.chromium.html"
  Delete "${dir}\resources.pak"
  Delete "${dir}\snapshot_blob.bin"
  Delete "${dir}\v8_context_snapshot.bin"
  Delete "${dir}\vk_swiftshader.dll"
  Delete "${dir}\vk_swiftshader_icd.json"
  Delete "${dir}\vulkan-1.dll"
  Delete "${dir}\${UNIMUX_ELECTRON_UNINSTALLER}"
  RMDir /r "${dir}\locales"
  Delete "${dir}\resources\app.asar"
  RMDir /r "${dir}\resources\app.asar.unpacked"
  RMDir /r "${dir}\resources\app"
  Delete "${dir}\resources\app-update.yml"
  Delete "${dir}\resources\elevate.exe"
!macroend

; Stamps the app's AppUserModelID on a shortcut that exists (taskbar grouping and notifications follow it).
!macro UNIMUX_STAMP_AUMID shortcut
  ${If} ${FileExists} "${shortcut}"
    !insertmacro SetLnkAppUserModelId "${shortcut}"
  ${EndIf}
!macroend

; Opening files from Explorer (`unimux.exe "<path>"`, src-tauri/crates/unimux-app/src/open_files.rs). SHCTX is HKCU for a
; per-user install and HKLM for an all-users one, so every key lands under the install's own Software\Classes:
; - Applications\unimux.exe: the app in "Open with" for the types in SupportedTypes, with its name and icon;
; - the ProgID unimux.file and an OpenWithProgids value per extension: unimux in each type's "Open with" list, and a choice in
;   Settings > Default apps through the Capabilities registered in RegisteredApplications. No extension's default handler is
;   ever set: the user picks unimux if they want it;
; - *\shell\unimux: "Open in unimux" in the context menu of every file (on Windows 11 under "Show more options"), in the
;   installer's language.
; An update (`--updated`) writes them again, so they always point at the current install dir; the uninstaller removes those
; that still point at its own exe.
!define UNIMUX_PROGID "unimux.file"
!define UNIMUX_APPKEY "Software\Classes\Applications\${MAINBINARYNAME}.exe"
!define UNIMUX_VERBKEY "Software\Classes\*\shell\${PRODUCTNAME}"
!define UNIMUX_CAPKEY "${MANUPRODUCTKEY}\Capabilities"

; Text and source files unimux's editor opens.
!macro UNIMUX_FOR_EXTENSIONS action
  !insertmacro ${action} ".txt"
  !insertmacro ${action} ".text"
  !insertmacro ${action} ".md"
  !insertmacro ${action} ".markdown"
  !insertmacro ${action} ".mdx"
  !insertmacro ${action} ".json"
  !insertmacro ${action} ".jsonc"
  !insertmacro ${action} ".json5"
  !insertmacro ${action} ".js"
  !insertmacro ${action} ".mjs"
  !insertmacro ${action} ".cjs"
  !insertmacro ${action} ".jsx"
  !insertmacro ${action} ".ts"
  !insertmacro ${action} ".mts"
  !insertmacro ${action} ".cts"
  !insertmacro ${action} ".tsx"
  !insertmacro ${action} ".vue"
  !insertmacro ${action} ".svelte"
  !insertmacro ${action} ".css"
  !insertmacro ${action} ".scss"
  !insertmacro ${action} ".less"
  !insertmacro ${action} ".html"
  !insertmacro ${action} ".htm"
  !insertmacro ${action} ".xml"
  !insertmacro ${action} ".xaml"
  !insertmacro ${action} ".svg"
  !insertmacro ${action} ".yml"
  !insertmacro ${action} ".yaml"
  !insertmacro ${action} ".toml"
  !insertmacro ${action} ".ini"
  !insertmacro ${action} ".cfg"
  !insertmacro ${action} ".conf"
  !insertmacro ${action} ".properties"
  !insertmacro ${action} ".env"
  !insertmacro ${action} ".log"
  !insertmacro ${action} ".csv"
  !insertmacro ${action} ".tsv"
  !insertmacro ${action} ".sql"
  !insertmacro ${action} ".diff"
  !insertmacro ${action} ".patch"
  !insertmacro ${action} ".py"
  !insertmacro ${action} ".rb"
  !insertmacro ${action} ".php"
  !insertmacro ${action} ".lua"
  !insertmacro ${action} ".pl"
  !insertmacro ${action} ".rs"
  !insertmacro ${action} ".go"
  !insertmacro ${action} ".java"
  !insertmacro ${action} ".kt"
  !insertmacro ${action} ".kts"
  !insertmacro ${action} ".gradle"
  !insertmacro ${action} ".scala"
  !insertmacro ${action} ".swift"
  !insertmacro ${action} ".dart"
  !insertmacro ${action} ".c"
  !insertmacro ${action} ".h"
  !insertmacro ${action} ".cpp"
  !insertmacro ${action} ".cc"
  !insertmacro ${action} ".hpp"
  !insertmacro ${action} ".cs"
  !insertmacro ${action} ".csproj"
  !insertmacro ${action} ".fs"
  !insertmacro ${action} ".sh"
  !insertmacro ${action} ".bash"
  !insertmacro ${action} ".zsh"
  !insertmacro ${action} ".ps1"
  !insertmacro ${action} ".psm1"
  !insertmacro ${action} ".bat"
  !insertmacro ${action} ".cmd"
  !insertmacro ${action} ".gitignore"
  !insertmacro ${action} ".gitattributes"
  !insertmacro ${action} ".editorconfig"
  !insertmacro ${action} ".dockerfile"
  !insertmacro ${action} ".tf"
  !insertmacro ${action} ".graphql"
  !insertmacro ${action} ".proto"
!macroend

!macro UNIMUX_REGISTER_EXTENSION ext
  WriteRegStr SHCTX "${UNIMUX_APPKEY}\SupportedTypes" "${ext}" ""
  WriteRegStr SHCTX "Software\Classes\${ext}\OpenWithProgids" "${UNIMUX_PROGID}" ""
  WriteRegStr SHCTX "${UNIMUX_CAPKEY}\FileAssociations" "${ext}" "${UNIMUX_PROGID}"
!macroend

; Only our value; the type's key goes only when nothing else is left in it.
!macro UNIMUX_UNREGISTER_EXTENSION ext
  DeleteRegValue SHCTX "Software\Classes\${ext}\OpenWithProgids" "${UNIMUX_PROGID}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\${ext}\OpenWithProgids"
  DeleteRegKey /ifempty SHCTX "Software\Classes\${ext}"
!macroend

; "Open in unimux" in the installer's language ($LANGUAGE: Polish 1045, German 1031, Spanish 1034, French 1036, Portuguese
; (Brazil) 1046, anything else English). Non-ASCII letters are made from their code points: the hooks file is read in the
; build machine's ANSI code page.
!macro UNIMUX_VERB_TEXT out
  ${If} $LANGUAGE = 1045
    IntFmt $R9 "%c" 0x00F3
    StrCpy ${out} "Otw$R9rz w ${PRODUCTNAME}"
  ${ElseIf} $LANGUAGE = 1031
    IntFmt $R9 "%c" 0x00F6
    StrCpy ${out} "In ${PRODUCTNAME} $R9ffnen"
  ${ElseIf} $LANGUAGE = 1034
    StrCpy ${out} "Abrir en ${PRODUCTNAME}"
  ${ElseIf} $LANGUAGE = 1036
    StrCpy ${out} "Ouvrir dans ${PRODUCTNAME}"
  ${ElseIf} $LANGUAGE = 1046
    StrCpy ${out} "Abrir no ${PRODUCTNAME}"
  ${Else}
    StrCpy ${out} "Open in ${PRODUCTNAME}"
  ${EndIf}
!macroend

!macro UNIMUX_REGISTER_OPEN_WITH
  StrCpy $R5 '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  StrCpy $R6 '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  ; The app itself: "Open with" > unimux, with its own name and icon.
  WriteRegStr SHCTX "${UNIMUX_APPKEY}" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNIMUX_APPKEY}\DefaultIcon" "" $R6
  WriteRegStr SHCTX "${UNIMUX_APPKEY}\shell\open\command" "" $R5
  ; The ProgID the extensions and Default apps point at.
  WriteRegStr SHCTX "Software\Classes\${UNIMUX_PROGID}\DefaultIcon" "" $R6
  WriteRegStr SHCTX "Software\Classes\${UNIMUX_PROGID}\Application" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${UNIMUX_PROGID}\Application" "ApplicationIcon" $R6
  WriteRegStr SHCTX "Software\Classes\${UNIMUX_PROGID}\shell\open\command" "" $R5
  ; Settings > Default apps > unimux.
  WriteRegStr SHCTX "${UNIMUX_CAPKEY}" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNIMUX_CAPKEY}" "ApplicationDescription" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNIMUX_CAPKEY}" "ApplicationIcon" $R6
  !insertmacro UNIMUX_FOR_EXTENSIONS UNIMUX_REGISTER_EXTENSION
  WriteRegStr SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}" "${UNIMUX_CAPKEY}"
  ; The context menu of every file.
  !insertmacro UNIMUX_VERB_TEXT $R7
  WriteRegStr SHCTX "${UNIMUX_VERBKEY}" "MUIVerb" $R7
  WriteRegStr SHCTX "${UNIMUX_VERBKEY}" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe"'
  WriteRegStr SHCTX "${UNIMUX_VERBKEY}\command" "" $R5
  ; Explorer reads the associations again.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ClearErrors
!macroend

; Removes what still points at this install's exe (another install may have taken a key over since).
!macro UNIMUX_UNREGISTER_OPEN_WITH
  StrCpy $R5 '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  ReadRegStr $R7 SHCTX "${UNIMUX_APPKEY}\shell\open\command" ""
  ${If} $R7 == $R5
    DeleteRegKey SHCTX "${UNIMUX_APPKEY}"
  ${EndIf}
  ReadRegStr $R7 SHCTX "Software\Classes\${UNIMUX_PROGID}\shell\open\command" ""
  ${If} $R7 == $R5
    DeleteRegKey SHCTX "Software\Classes\${UNIMUX_PROGID}"
    !insertmacro UNIMUX_FOR_EXTENSIONS UNIMUX_UNREGISTER_EXTENSION
    DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}"
    DeleteRegKey SHCTX "${UNIMUX_CAPKEY}"
  ${EndIf}
  ReadRegStr $R7 SHCTX "${UNIMUX_VERBKEY}\command" ""
  ${If} $R7 == $R5
    DeleteRegKey SHCTX "${UNIMUX_VERBKEY}"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ClearErrors
!macroend

!macro NSIS_HOOK_PREINSTALL
!if "${PRODUCTNAME}" == "unimux"
  ; An `--updated` run (electron-updater, or the unimux update window) keeps the user's shortcuts as they are: the template
  ; neither re-creates a Start menu entry nor a desktop shortcut the user deleted. The WebView2 section already ran.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  ClearErrors

  ; 1. An Electron 1.1.x install: its dir becomes the install dir while unimux 1.2.0 has none of its own yet.
  StrCpy $UnimuxElectronDir ""
  ReadRegStr $R0 HKCU "${UNIMUX_ELECTRON_KEY}" "InstallLocation"
  ClearErrors
  ${If} $R0 != ""
    ; A quoted value (never written by electron-builder, but cheap to accept).
    StrCpy $R1 $R0 1
    ${If} $R1 == '"'
      StrCpy $R0 $R0 "" 1
      StrCpy $R0 $R0 -1
    ${EndIf}
    ; Only a folder that still holds the Electron app counts: a stale key never moves the install anywhere.
    ${If} ${FileExists} "$R0\${MAINBINARYNAME}.exe"
    ${OrIf} ${FileExists} "$R0\${UNIMUX_ELECTRON_UNINSTALLER}"
      ReadRegStr $R2 SHCTX "${MANUPRODUCTKEY}" ""
      ClearErrors
      ; Only the template's default: a folder given with /D= (or chosen on the directory page) is kept.
      ${If} $R2 == ""
      ${AndIf} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
        ; Tauri created the default folder in SetOutPath already; it goes again when it is empty.
        ${If} $INSTDIR != $R0
          RMDir $INSTDIR
        ${EndIf}
        StrCpy $INSTDIR $R0
      ${EndIf}
      ; NSIS compares case-insensitively: the same folder in another spelling counts.
      ${If} $INSTDIR == $R0
        StrCpy $UnimuxElectronDir $R0
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; 1b. An Electron 1.1.x install for all users ("Anyone who uses this computer": HKLM, often a folder only administrators
  ;     may write). This per-user installer cannot take its folder over, so 1.2.x stays in its own; the old app is waited for
  ;     and removed by its own uninstaller below (elevated: an administrator prompt, as its own updates had), and
  ;     POSTINSTALL points the shortcuts at the new exe.
  StrCpy $UnimuxMachineDir ""
  StrCpy $UnimuxMachineDesktop 0
  ${If} $UnimuxElectronDir == ""
    SetRegView 64
    ReadRegStr $R0 HKLM "${UNIMUX_ELECTRON_KEY}" "InstallLocation"
    SetRegView lastused
    ClearErrors
    ${If} $R0 != ""
      StrCpy $R1 $R0 1
      ${If} $R1 == '"'
        StrCpy $R0 $R0 "" 1
        StrCpy $R0 $R0 -1
      ${EndIf}
      ${If} $R0 != $INSTDIR
      ${AndIf} ${FileExists} "$R0\${UNIMUX_ELECTRON_UNINSTALLER}"
        StrCpy $UnimuxMachineDir $R0
        SetShellVarContext all
        ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
          StrCpy $UnimuxMachineDesktop 1
        ${EndIf}
        SetShellVarContext current
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; 2. The running app (Electron 1.1.x, or an older 1.2.x) gets 30 s to wind down and save before the Restart Manager check.
  ${If} $UnimuxMachineDir != ""
    !insertmacro UNIMUX_WAIT_FOR_EXIT "$UnimuxMachineDir\${MAINBINARYNAME}.exe"
  ${EndIf}
  !insertmacro UNIMUX_WAIT_FOR_EXIT "$INSTDIR\${MAINBINARYNAME}.exe"

  ; 3b. The all-users uninstaller, elevated, from a copy. Not `--updated`: it removes the all-users shortcuts it made. A
  ;     declined prompt leaves the old app installed; 1.2.x works anyway and the user can remove 1.1.x in Apps & features.
  ${If} $UnimuxMachineDir != ""
    SetOutPath $TEMP
    InitPluginsDir
    ClearErrors
    CopyFiles /SILENT "$UnimuxMachineDir\${UNIMUX_ELECTRON_UNINSTALLER}" "$PLUGINSDIR\old-machine-uninstaller.exe"
    ${IfNot} ${Errors}
      ExecShellWait "runas" "$PLUGINSDIR\old-machine-uninstaller.exe" '/S /allusers /KEEP_APP_DATA _?=$UnimuxMachineDir' SW_HIDE
      Delete "$PLUGINSDIR\old-machine-uninstaller.exe"
    ${EndIf}
    ClearErrors
    SetOutPath $INSTDIR
  ${EndIf}

  ; 3. The Electron uninstaller, from a copy (it removes its own file), keeping the data and the shortcuts. The working
  ;    directory is outside the install dir so the uninstaller can empty it.
  ${If} $UnimuxElectronDir != ""
    SetOutPath $TEMP
    StrCpy $R3 1
    ${If} ${FileExists} "$UnimuxElectronDir\${UNIMUX_ELECTRON_UNINSTALLER}"
      InitPluginsDir
      ClearErrors
      CopyFiles /SILENT "$UnimuxElectronDir\${UNIMUX_ELECTRON_UNINSTALLER}" "$PLUGINSDIR\old-uninstaller.exe"
      ${IfNot} ${Errors}
        ClearErrors
        ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated _?=$UnimuxElectronDir' $R3
        ${If} ${Errors}
          StrCpy $R3 1
        ${EndIf}
        Delete "$PLUGINSDIR\old-uninstaller.exe"
      ${EndIf}
      ClearErrors
    ${EndIf}
    ; The fallback: no second Apps & features entry and no Electron runtime left next to the new exe.
    ReadRegStr $R4 HKCU "${UNIMUX_ELECTRON_UNINSTKEY}" "UninstallString"
    ClearErrors
    ${If} $R3 != 0
    ${OrIf} $R4 != ""
      DeleteRegKey HKCU "${UNIMUX_ELECTRON_UNINSTKEY}"
      DeleteRegKey HKCU "${UNIMUX_ELECTRON_KEY}"
      !insertmacro UNIMUX_REMOVE_ELECTRON_FILES "$UnimuxElectronDir"
    ${EndIf}
    ClearErrors
    SetOutPath $INSTDIR
  ${EndIf}
  SetOutPath $INSTDIR
!endif
!macroend

!macro NSIS_HOOK_POSTINSTALL
!if "${PRODUCTNAME}" == "unimux"
  ; 1. `installer-done` for the update window (1.1.x and 1.2.x read the same file). While %APPDATA%\ajzakomator exists (a
  ;    build that has not moved its data yet, or the junction left after the move) the marker goes there; %APPDATA%\unimux
  ;    is never created while the old directory is still real, so the app's own move finds it free.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${IfNot} ${Errors}
    ${If} ${FileExists} "$APPDATA\ajzakomator\*.*"
      CreateDirectory "$APPDATA\ajzakomator\update"
      FileOpen $R2 "$APPDATA\ajzakomator\update\installer-done" w
    ${Else}
      CreateDirectory "$APPDATA\unimux\update"
      FileOpen $R2 "$APPDATA\unimux\update\installer-done" w
    ${EndIf}
    ${If} $R2 != ""
      FileWrite $R2 "${VERSION}"
      FileClose $R2
    ${EndIf}
  ${EndIf}
  ClearErrors

  ; 1b. After an all-users 1.1.x: the user's Start menu entry, a desktop shortcut where the old app had one, and a taskbar
  ;     pin all start the new exe (the old ones pointed into the folder its uninstaller just emptied).
  ${If} $UnimuxMachineDir != ""
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${If} $UnimuxMachineDesktop = 1
    ${OrIf} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${EndIf}
    ${If} ${FileExists} "${UNIMUX_TASKBAR_PIN}"
      CreateShortcut "${UNIMUX_TASKBAR_PIN}" "$INSTDIR\${MAINBINARYNAME}.exe"
    ${EndIf}
  ${EndIf}

  ; 2. Existing shortcuts (an update keeps them; 0.8.4 and older stamped com.ajzakomator.app) get the current AUMID, so the
  ;    taskbar groups the window with its pin and notifications keep working.
  !insertmacro UNIMUX_STAMP_AUMID "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !if "${STARTMENUFOLDER}" != ""
    !insertmacro UNIMUX_STAMP_AUMID "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !endif
  !insertmacro UNIMUX_STAMP_AUMID "$DESKTOP\${PRODUCTNAME}.lnk"
  !insertmacro UNIMUX_STAMP_AUMID "${UNIMUX_TASKBAR_PIN}"
  ClearErrors

  ; 2b. "Open with", Default apps and the context menu, pointing at this install's exe (an update writes them again).
  !insertmacro UNIMUX_REGISTER_OPEN_WITH

  ; 3. electron-updater's `--force-run`: start the new app as the user once the files are in place.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--force-run" $R1
  ${IfNot} ${Errors}
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
  ${EndIf}
  ClearErrors
!endif
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!if "${PRODUCTNAME}" == "unimux"
  ; After the files are gone (a cancelled uninstall keeps the registration): "Open with", Default apps and the context menu.
  !insertmacro UNIMUX_UNREGISTER_OPEN_WITH
!endif
!macroend
