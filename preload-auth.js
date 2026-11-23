const { contextBridge, ipcRenderer } = require("electron");

// Narrow bridge for the login pop-up only: the server page reports the
// finished login; nothing else is exposed.
contextBridge.exposeInMainWorld("nomokitDesktopAuth", {
  complete: (payload) => {
    if (location.origin !== "https://nomo-kit.com") return;
    ipcRenderer.send("auth:complete", payload);
  },
});
