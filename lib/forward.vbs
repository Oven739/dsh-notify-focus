' dshnotify protocol forwarder.
'
' Why this exists: the handler used to be powershell.exe, whose PE subsystem is
' WINDOWS_CUI -- the console window is created by the OS before the script can
' run, so -WindowStyle Hidden can only shrink it to ~250ms, never remove it.
' wscript.exe is WINDOWS_GUI and owns no console at all, and Run(..., 0, ...)
' passes SW_HIDE into CreateProcess, so the child console is hidden at creation.
'
' //B is required by the registry command: without batch mode any script error
' raises a modal dialog, which is worse than the flash we are removing.
Option Explicit

Dim sh, args, url, cmd

If WScript.Arguments.Count = 0 Then
  WScript.Quit 0
End If

url = WScript.Arguments(0)

' Forward to the existing PowerShell launcher unchanged; only the process that
' starts it changed. Quoting the script path guards against a future repo path
' containing spaces.
Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""G:\DSH\dsh-notify-focus\lib\launcher.ps1"" """ & url & """"

' 0 = SW_HIDE, False = do not wait.
sh.Run cmd, 0, False
