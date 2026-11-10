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

Dim sh, url, selfDir, launcher, cmd

If WScript.Arguments.Count = 0 Then
  WScript.Quit 0
End If

url = WScript.Arguments(0)

' Resolve launcher.ps1 relative to THIS file rather than from a fixed path.
' The plugin is installed by copying or linking into a profile, so its
' location differs per machine; a hardcoded absolute path made the protocol
' handler work only on the machine it was written on.
selfDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
launcher = selfDir & "\launcher.ps1"

If Not CreateObject("Scripting.FileSystemObject").FileExists(launcher) Then
  ' Nothing to run: exit quietly rather than raising a modal error dialog.
  WScript.Quit 1
End If

Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & launcher & """ """ & url & """"

' 0 = SW_HIDE, False = do not wait.
sh.Run cmd, 0, False
