const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("engineShell", {
  ping: () => ipcRenderer.invoke("shell:ping"),
  navigate: (target, viewport) => ipcRenderer.invoke("shell:navigate", target, viewport),
  loadHtml: (html, title, viewport) => ipcRenderer.invoke("shell:loadHtml", html, title, viewport),
  back: (viewport) => ipcRenderer.invoke("shell:back", viewport),
  forward: (viewport) => ipcRenderer.invoke("shell:forward", viewport),
  reload: (viewport) => ipcRenderer.invoke("shell:reload", viewport),
  setViewport: (viewport) => ipcRenderer.invoke("shell:setViewport", viewport),
  scroll: (deltaX, deltaY, viewport, extra) => ipcRenderer.invoke("shell:scroll", deltaX, deltaY, viewport, extra),
  hitTest: (x, y) => ipcRenderer.invoke("shell:hitTest", x, y),
  click: (x, y, viewport) => ipcRenderer.invoke("shell:click", x, y, viewport),
  type: (nodeId, text, options) => ipcRenderer.invoke("shell:type", nodeId, text, options),
  newTab: () => ipcRenderer.invoke("shell:newTab"),
  selectTab: (id) => ipcRenderer.invoke("shell:selectTab", id),
  closeTab: (id) => ipcRenderer.invoke("shell:closeTab", id),
  tabs: () => ipcRenderer.invoke("shell:tabs"),
});
