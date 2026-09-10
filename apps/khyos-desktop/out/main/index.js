import { app, Menu, shell, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";
import { fork } from "child_process";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
function createMenu(mainWindow) {
  const isMac = process.platform === "darwin";
  const template = [
    // 文件菜单
    {
      label: "文件",
      submenu: [
        {
          label: "新建任务",
          accelerator: "Ctrl+N",
          click: () => mainWindow.webContents.send("menu:new-task")
        },
        {
          label: "打开工作区",
          accelerator: "Ctrl+O",
          click: () => mainWindow.webContents.send("menu:open-workspace")
        },
        { type: "separator" },
        {
          label: "关闭窗口",
          accelerator: "Ctrl+W",
          click: () => mainWindow.close()
        }
      ]
    },
    // 视图菜单
    {
      label: "视图",
      submenu: [
        {
          label: "切换全屏",
          accelerator: "F11",
          click: () => mainWindow.setFullScreen(!mainWindow.isFullScreen())
        },
        { type: "separator" },
        {
          label: "放大",
          accelerator: "Ctrl+=",
          click: () => {
            const zoom = mainWindow.webContents.getZoomFactor();
            mainWindow.webContents.setZoomFactor(zoom + 0.1);
          }
        },
        {
          label: "缩小",
          accelerator: "Ctrl+-",
          click: () => {
            const zoom = mainWindow.webContents.getZoomFactor();
            mainWindow.webContents.setZoomFactor(zoom - 0.1);
          }
        },
        {
          label: "实际大小",
          accelerator: "Ctrl+0",
          click: () => mainWindow.webContents.setZoomFactor(1)
        }
      ]
    },
    // 窗口菜单
    {
      label: "窗口",
      submenu: [
        {
          label: "最小化",
          accelerator: "Ctrl+M",
          click: () => mainWindow.minimize()
        },
        {
          label: "最大化",
          click: () => {
            if (mainWindow.isMaximized()) mainWindow.unmaximize();
            else mainWindow.maximize();
          }
        }
      ]
    },
    // 帮助菜单
    {
      label: "帮助",
      submenu: [
        {
          label: "关于 KhyOS Desktop",
          click: () => mainWindow.webContents.send("menu:about")
        },
        {
          label: "检查更新",
          click: () => mainWindow.webContents.send("menu:check-update")
        },
        {
          label: "问题反馈",
          click: () => shell.openExternal("https://khyquant.top/feedback")
        },
        { type: "separator" },
        {
          label: "导出日志",
          click: () => mainWindow.webContents.send("menu:export-logs")
        },
        {
          label: "进程监视器",
          click: () => mainWindow.webContents.send("menu:process-monitor")
        },
        {
          label: "开始性能录制",
          click: () => mainWindow.webContents.send("menu:start-recording")
        },
        {
          label: "停止性能录制",
          click: () => mainWindow.webContents.send("menu:stop-recording")
        },
        { type: "separator" },
        {
          label: "切换开发者工具",
          accelerator: "F12",
          click: () => mainWindow.webContents.toggleDevTools()
        },
        {
          label: "抓取 Agent stdio 通信",
          click: () => mainWindow.webContents.send("menu:toggle-stdio-tap")
        },
        { type: "separator" },
        {
          label: "清除所有数据",
          click: () => mainWindow.webContents.send("menu:clear-data")
        }
      ]
    }
  ];
  if (isMac) {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    });
  }
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
let hostProcess = null;
function startHostProcess() {
  const hostPath = path.join(__dirname, "../host/index.js");
  hostProcess = fork(hostPath, [], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
  hostProcess.stdout?.on("data", (data) => console.log("[host]", data.toString()));
  hostProcess.stderr?.on("data", (data) => console.error("[host]", data.toString()));
  hostProcess.on("message", (msg) => console.log("[host] message:", msg));
  hostProcess.on("exit", (code) => {
    console.log(`[host] 进程退出, code=${code}`);
    hostProcess = null;
  });
}
function createWindow() {
  const win = new BrowserWindow({
    width: 1216,
    height: 808,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173/";
  if (process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === "development") {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  win.once("ready-to-show", () => win.show());
  ipcMain.handle("window:minimize", () => win.minimize());
  ipcMain.handle("window:maximize", () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle("window:close", () => win.close());
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("settings:get", async () => ({
    locale: "zh-CN",
    themeMode: "dark",
    desktopWindowSize: { width: 1216, height: 808, maximized: false }
  }));
  ipcMain.handle("settings:set", async (e, key, value) => {
    console.log(`[settings] set ${key} =`, value);
    return true;
  });
  ipcMain.handle("theme:get", async () => "dark");
  ipcMain.handle("theme:set", async (e, mode) => {
    console.log(`[theme] set mode = ${mode}`);
    return true;
  });
  ipcMain.handle("fs:openDirectory", async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("fs:readFile", async (e, filePath) => {
    const fs = await import("fs/promises");
    return fs.readFile(filePath, "utf-8");
  });
  ipcMain.handle("fs:writeFile", async (e, filePath, content) => {
    const fs = await import("fs/promises");
    await fs.writeFile(filePath, content, "utf-8");
    return true;
  });
  ipcMain.handle("ai:send", async (e, payload) => {
    console.log("[ai] send", payload);
    return { ok: true, text: "stub response" };
  });
  ipcMain.handle("ai:stream", async (e, payload) => {
    console.log("[ai] stream", payload);
    return { ok: true };
  });
  ipcMain.handle("session:create", async (e, workspacePath) => {
    return { id: `sess_${Date.now()}`, workspacePath };
  });
  ipcMain.handle("session:list", async () => []);
  ipcMain.handle("host:status", async () => {
    return { running: !!hostProcess, pid: hostProcess?.pid };
  });
  return win;
}
app.whenReady().then(() => {
  startHostProcess();
  const win = createWindow();
  createMenu(win);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWin = createWindow();
      createMenu(newWin);
    }
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
