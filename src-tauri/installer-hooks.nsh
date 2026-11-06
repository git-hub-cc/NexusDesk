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
