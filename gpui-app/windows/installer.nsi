Unicode True
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define PRODUCT_NAME "myPaint GPUI Compare"
!define PRODUCT_VERSION "0.2.0"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\io.github.parkjh2568.mypaint.gpui"

!ifndef INPUT_EXE
    !error "Pass an absolute INPUT_EXE path with /DINPUT_EXE."
!endif
!ifndef OUTPUT_INSTALLER
    !error "Pass an absolute OUTPUT_INSTALLER path with /DOUTPUT_INSTALLER."
!endif

Name "${PRODUCT_NAME}"
OutFile "${OUTPUT_INSTALLER}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
VIProductVersion "0.2.0.0"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} installer"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright myPaint contributors"

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
    SetShellVarContext current
    SetOutPath "$INSTDIR"
    ClearErrors
    File /oname=mypaint-gpui.exe "${INPUT_EXE}"
    IfErrors installFailed
    WriteUninstaller "$INSTDIR\uninstall.exe"
    IfErrors installFailed

    CreateShortcut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\mypaint-gpui.exe"

    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "myPaint"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\mypaint-gpui.exe"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
    WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
    Goto installDone

    installFailed:
    SetErrorLevel 1
    Abort "Close the running myPaint GPUI Compare app and try the installation again."

    installDone:
SectionEnd

Section "Uninstall"
    SetShellVarContext current
    Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
    ClearErrors
    Delete "$INSTDIR\mypaint-gpui.exe"
    IfErrors uninstallFailed
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
    Delete "$INSTDIR\uninstall.exe"
    RMDir "$INSTDIR"
    Goto uninstallDone

    uninstallFailed:
    SetErrorLevel 1
    Abort "Close the running myPaint GPUI Compare app and try the removal again."

    uninstallDone:
SectionEnd
