; Included by electron-builder's NSIS installer.
; mongod.exe needs the Microsoft Visual C++ 2015-2022 runtime (x64). Install it silently
; when it is missing or older than the 2019 toolset (14.20); vc_redist asks for admin rights itself.
!macro customInstall
  StrCpy $1 "0"
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ReadRegDWORD $2 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Minor"
  SetRegView 32
  ${If} $0 != 1
    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    ReadRegDWORD $2 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Minor"
  ${EndIf}
  ${If} $0 != 1
    StrCpy $1 "1"
  ${ElseIf} $2 < 20
    StrCpy $1 "1"
  ${EndIf}
  ${If} $1 == "1"
    DetailPrint "Installing Microsoft Visual C++ Runtime..."
    ExecWait '"$INSTDIR\resources\vcredist\vc_redist.x64.exe" /install /quiet /norestart' $3
    DetailPrint "Visual C++ Runtime installer finished (code $3)"
  ${EndIf}
!macroend
