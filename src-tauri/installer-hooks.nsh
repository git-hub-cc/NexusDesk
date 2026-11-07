; This include is resolved from the source directory by Tauri.
!define NEXUSDESK_RUNTIME_SCRIPT "${__FILEDIR__}\ensure-vc-runtime.ps1"

!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  File /oname=$PLUGINSDIR\ensure-vc-runtime.ps1 "${NEXUSDESK_RUNTIME_SCRIPT}"
  DetailPrint "Checking Microsoft Visual C++ runtime (${ARCH})..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ensure-vc-runtime.ps1" -Architecture "${ARCH}"'
  Pop $0
  ${If} $0 == 3010
    SetRebootFlag true
  ${ElseIf} $0 != 0
    DetailPrint "Microsoft Visual C++ runtime setup failed: $0"
    MessageBox MB_OK|MB_ICONSTOP "Microsoft Visual C++ runtime setup failed ($0). Check your Internet connection and run setup again. See the installation details for more information." /SD IDOK
    SetErrorLevel 1603
    Abort
  ${EndIf}
!macroend

; 注册为 Windows 的浏览器候选，并让旧版 Windows 直接使用 HTTP/HTTPS 关联。
!macro NSIS_HOOK_POSTINSTALL
  SetRegView 64
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\${PRODUCTNAME}" "" "${PRODUCTNAME}"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\${PRODUCTNAME}" "LocalizedString" "${PRODUCTNAME}"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\${PRODUCTNAME}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\${PRODUCTNAME}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"

  WriteRegStr HKLM "Software\RegisteredApplications" "${PRODUCTNAME}" "Software\Clients\StartMenuInternet\${PRODUCTNAME}\Capabilities"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\${PRODUCTNAME}\Capabilities" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\${PRODUCTNAME}\Capabilities" "ApplicationDescription" "${PRODUCTNAME} 浏览器"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\${PRODUCTNAME}\Capabilities\URLAssociations" "http" "${PRODUCTNAME}URL"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\${PRODUCTNAME}\Capabilities\URLAssociations" "https" "${PRODUCTNAME}URL"

  WriteRegStr HKLM "Software\Classes\${PRODUCTNAME}URL" "" "URL:${PRODUCTNAME} URL"
  WriteRegStr HKLM "Software\Classes\${PRODUCTNAME}URL" "URL Protocol" ""
  WriteRegStr HKLM "Software\Classes\${PRODUCTNAME}URL\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr HKLM "Software\Classes\${PRODUCTNAME}URL\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  ; 直接写入协议命令，兼容尚未使用 UserChoice 保护的 Windows 版本。
  WriteRegStr HKLM "Software\Classes\http\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr HKLM "Software\Classes\https\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  SetRegView 64
  ReadRegStr $0 HKLM "Software\Classes\http\shell\open\command" ""
  ${If} $0 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
    DeleteRegKey HKLM "Software\Classes\http\shell\open\command"
  ${EndIf}
  ReadRegStr $0 HKLM "Software\Classes\https\shell\open\command" ""
  ${If} $0 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
    DeleteRegKey HKLM "Software\Classes\https\shell\open\command"
  ${EndIf}
  DeleteRegKey HKLM "Software\Classes\${PRODUCTNAME}URL"
  DeleteRegKey HKLM "Software\Clients\StartMenuInternet\${PRODUCTNAME}"
  DeleteRegValue HKLM "Software\RegisteredApplications" "${PRODUCTNAME}"
!macroend
