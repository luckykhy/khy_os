using System;
using System.Diagnostics;
using System.IO;

class KhyosMarkdownLauncher {
    static void Main(string[] args) {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string bridge = Path.Combine(baseDir, "khyos-md-bridge.js");
        string file = args.Length > 0 ? args[0] : "";

        // Find node.exe: fnm real path first, then alias, then PATH
        string appdata = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        string[] candidates = new string[] {
            Path.Combine(appdata, "fnm", "node-versions", "v24.18.0", "installation", "node.exe"),
            Path.Combine(appdata, "fnm", "aliases", "default", "node.exe"),
            @"C:\Program Files\nodejs\node.exe",
        };

        string node = null;
        foreach (string c in candidates) {
            if (File.Exists(c)) { node = c; break; }
        }
        if (node == null) {
            node = "node.exe";
        }

        try {
            ProcessStartInfo psi = new ProcessStartInfo {
                FileName = node,
                Arguments = "\"" + bridge + "\" \"" + file + "\"",
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                UseShellExecute = false
            };
            Process.Start(psi);
        } catch (Exception) {
            // Silent fail - non-interactive launcher
        }
    }
}
