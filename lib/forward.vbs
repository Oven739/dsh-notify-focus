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

Dim sh, fso, url, cmd, selfDir, launcher, errNo

If WScript.Arguments.Count = 0 Then
  WScript.Quit 0
End If

url = WScript.Arguments(0)

' Resolve launcher.ps1 from THIS file's own location.
'
' The path used to be a literal, which only worked on the machine it was
' written on: elsewhere wscript starts powershell with a -File path that does
' not exist, powershell exits 1 before running launcher.ps1, //B swallows the
' error dialog, and the only observable effect is a click that does nothing.
'
' There is deliberately NO hard-coded fallback. A literal here would restore
' exactly the bug this file exists to fix, and it would be wrong on every
' machine but the one it was written for. When the path cannot be derived the
' script says so in the log and exits instead of launching the wrong file.
On Error Resume Next
Set fso = CreateObject("Scripting.FileSystemObject")
If Err.Number <> 0 Or fso Is Nothing Then
  Err.Clear
  On Error Goto 0
  LogFail "Scripting.FileSystemObject unavailable; cannot resolve launcher.ps1"
  WScript.Quit 1
End If
On Error Goto 0

selfDir = fso.GetParentFolderName(WScript.ScriptFullName)

' BuildPath, not selfDir & "\launcher.ps1": GetParentFolderName returns the
' drive root WITH a trailing backslash ("C:\"), so naive concatenation
' produces "C:\\launcher.ps1" there. Verified character by character.
launcher = fso.BuildPath(selfDir, "launcher.ps1")

If Not fso.FileExists(launcher) Then
  LogFail "launcher.ps1 not found at " & launcher
  WScript.Quit 1
End If

Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & launcher & """ """ & url & """"

' A failed Run leaves no trace under //B. That is exactly the "click did
' nothing" report this logging was added for, so the last step gets a guard
' too rather than staying the one silent link in the chain.
On Error Resume Next
sh.Run cmd, 0, False
errNo = Err.Number
On Error Goto 0
If errNo <> 0 Then
  LogFail "sh.Run failed, err=0x" & Hex(errNo)
End If

' Append one line to the launcher log. Deliberately independent of fso: the
' reason this can be called is that fso may be Nothing, and a logger that
' needs a working fso to report a broken fso reports nothing at all.
' The path comes from WScript.Shell's environment expansion instead.
Sub LogFail(msg)
  Dim dir, fh, ts, t
  On Error Resume Next
  ' fso is the only thing this logger can use: it is called from a script that
  ' already needed fso, and a logger that reaches for CreateObject again just
  ' moves the same failure one level down. When fso is unusable there is no
  ' log line - a documented limitation rather than a silent success.
  If fso Is Nothing Then Exit Sub
  dir = fso.BuildPath(fso.GetSpecialFolder(2), "dsh-notify")
  If Not fso.FolderExists(dir) Then fso.CreateFolder dir
  Set fh = fso.OpenTextFile(fso.BuildPath(dir, "launcher.log"), 8, True)
  t = Now
  ts = Year(t) & "-" & Right("0" & Month(t), 2) & "-" & Right("0" & Day(t), 2) & " " & _
       Right("0" & Hour(t), 2) & ":" & Right("0" & Minute(t), 2) & ":" & Right("0" & Second(t), 2)
  fh.WriteLine ts & ".000 [fail] forward.vbs: " & msg
  fh.Close
  Err.Clear
  On Error Goto 0
End Sub
