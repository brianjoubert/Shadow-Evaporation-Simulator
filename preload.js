const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openGdsDialog: () => ipcRenderer.invoke("dialog:openGds"),
  saveGdsDialog: (payload) => ipcRenderer.invoke("dialog:saveGds", payload),
});
