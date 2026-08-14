' khyos-md-launch.vbs — Windows 隐藏式启动器（自定位，无控制台闪窗）。
'
' 由右键菜单命令 `wscript "<本文件>" "%1"` 调起：
'   1) 通过 WScript.ScriptFullName 自定位本脚本所在目录（绝不硬编码路径）。
'   2) 以 0=隐藏窗口模式后台运行 `node khyos-md-bridge.js "<目标文件>"`。
'   3) 桥接器自行起本地服务并打开浏览器，本启动器随即退出。
'
' 红线4（系统纯净）：纯用户级调用，不触碰系统目录/注册表写入（注册由 register-windows.ps1 负责）。
' 红线3（路径免疫）：目标路径用双引号包裹整体传递，空格/中文/特殊字符不断裂。

Option Explicit

Dim fso, shell, scriptDir, bridge, target, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' 自定位：本 VBS 所在目录即 tools/khyos-markdown/。
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
bridge = fso.BuildPath(scriptDir, "khyos-md-bridge.js")

If Not fso.FileExists(bridge) Then
    MsgBox "khyos-md-bridge.js 缺失：" & bridge, vbCritical, "khyosMarkdown"
    WScript.Quit 1
End If

' 取右键传入的第一个参数为目标文件（可能含空格/中文）。
target = ""
If WScript.Arguments.Count > 0 Then target = WScript.Arguments(0)

' 构造命令：双引号包裹 node 脚本与目标路径，保证路径免疫。
cmd = "node """ & bridge & """"
If Len(target) > 0 Then cmd = cmd & " """ & target & """"

' 0 = 隐藏窗口；False = 不等待（桥接器后台常驻服务）。
shell.Run cmd, 0, False
