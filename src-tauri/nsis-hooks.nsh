; 安装前先结束正在运行的实例：否则 NSIS 覆盖 am-hook GUI.exe 时会报
; “无法打开要安装的文件”，那是文件被占用，不是安装包坏了。
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing running am-hook GUI…"
  nsExec::Exec 'taskkill /F /IM "am-hook GUI.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "am-hook-gui.exe"'
  Pop $0
  Sleep 800
!macroend

; 卸载前同样处理，避免残留进程占着文件
!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Closing running am-hook GUI…"
  nsExec::Exec 'taskkill /F /IM "am-hook GUI.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /IM "am-hook-gui.exe"'
  Pop $0
  Sleep 500
!macroend
