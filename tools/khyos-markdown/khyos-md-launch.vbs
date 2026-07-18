' khyos-md-launch.vbs — 纯 ASCII，URL 编码传递中文路径
' 流程：VBS 对路径做 URL 编码(纯 ASCII) → 写临时文件 → Node 读取并解码 → 桥接器
Option Explicit
Dim fso, shell, scriptDir, bridge, target, tmpFile, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
bridge = fso.BuildPath(scriptDir, "khyos-md-target.js")
If Not fso.FileExists(bridge) Then
    MsgBox "Launcher missing: " & bridge, vbCritical, "khyosMarkdown"
    WScript.Quit 1
End If

target = ""
If WScript.Arguments.Count > 0 Then target = WScript.Arguments(0)

' URL 编码（纯 ASCII 输出，无编码问题）
Dim encoded
encoded = UrlEncode(target)

tmpFile = ""
If Len(encoded) > 0 Then
    tmpFile = fso.GetSpecialFolder(2).Path & "\khyos_md_target.txt"
    Dim ts
    Set ts = fso.CreateTextFile(tmpFile, True, False)
    ts.Write encoded
    ts.Close
    Set ts = Nothing
End If

cmd = "node """ & bridge & """"
If Len(tmpFile) > 0 Then cmd = cmd & " """ & tmpFile & """"
shell.Run cmd, 0, False

' ---- 自定义 hex（VBScript Hex() 仅支持 0-4095，中文 Unicode 码点会溢出）----
Function ToHex(n)
    Dim digits, val, r
    digits = "0123456789ABCDEF"
    val = n
    If val = 0 Then
        ToHex = "0"
        Exit Function
    End If
    ToHex = ""
    While val > 0
        r = val Mod 16
        ToHex = Mid(digits, r + 1, 1) & ToHex
        val = val \ 16
    Wend
End Function

' URL 编码函数（纯 ASCII 输出）
Function UrlEncode(s)
    Dim i, c, result, code
    result = ""
    For i = 1 To Len(s)
        c = Mid(s, i, 1)
        code = AscW(c)
        If (code >= 48 And code <= 57) Or (code >= 65 And code <= 90) Or (code >= 97 And code <= 122) Or code = 45 Or code = 46 Or code = 95 Then
            result = result & c
        ElseIf code = 32 Then
            result = result & "+"
        Else
            result = result & "%" & ToHex(code)
        End If
    Next
    UrlEncode = result
End Function
