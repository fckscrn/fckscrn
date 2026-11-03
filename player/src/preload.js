const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fck", {
  getState: () => ipcRenderer.invoke("state"),
  onState: cb => ipcRenderer.on("state", (_e, s) => cb(s)),
  cmd: (type, arg) => ipcRenderer.send("cmd", { type, arg }),
});
