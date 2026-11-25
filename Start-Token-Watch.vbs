Option Explicit
Dim runner, files, root, result, command
Set runner = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
runner.CurrentDirectory = root
command = "node.exe """ & root & "\scripts\start-floating.js"" --background"
On Error Resume Next
result = runner.Run(command, 0, True)
If Err.Number <> 0 Then
  MsgBox "Unable to start Token Watch. Install Node.js 22.13+ and run npm install in the project folder.", 48, "Token Watch"
ElseIf result <> 0 Then
  MsgBox "Token Watch could not start. Run npm install, then npm run floating to view details.", 48, "Token Watch"
End If
