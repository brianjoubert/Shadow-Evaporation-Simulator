const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#0d1117",
    title: "3D WebGL Manhattan Shadow Evaporation Simulator",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "src", "index.html"));

  if (process.argv.includes("--smoke-test")) {
    win.webContents.on("console-message", (_e, level, msg, line, src) => {
      console.log(`CONSOLE [${level}]: ${msg} (${src}:${line})`);
    });
    win.webContents.on("did-finish-load", () => {
      setTimeout(async () => {
        const metrics = await win.webContents.executeJavaScript(
          'document.getElementById("metricsBox").textContent'
        );
        console.log("METRICS_OUT:\n" + metrics);
        app.quit();
      }, 600);
    });
  }
}

ipcMain.handle("dialog:openGds", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Open GDSII Layout File",
    filters: [{ name: "GDSII Files", extensions: ["gds", "gds2"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths || filePaths.length === 0) return null;
  const filePath = filePaths[0];
  const buffer = fs.readFileSync(filePath);
  return {
    name: path.basename(filePath),
    path: filePath,
    bytes: new Uint8Array(buffer),
  };
});

ipcMain.handle("dialog:saveGds", async (_event, { defaultName, bytes }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Save Generated Manhattan GDSII File",
    defaultPath: defaultName || "test_manhattan_bandage.gds",
    filters: [{ name: "GDSII Files", extensions: ["gds"] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, Buffer.from(bytes));
  return filePath;
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
