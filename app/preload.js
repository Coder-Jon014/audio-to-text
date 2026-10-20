'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  checkPython: (p) => ipcRenderer.invoke('python:check', p),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  pickFolder: (kind) => ipcRenderer.invoke('dialog:pickFolder', kind),
  readText: (file) => ipcRenderer.invoke('fs:readText', file),
  openPath: (file) => ipcRenderer.invoke('shell:open', file),
  showInFolder: (file) => ipcRenderer.invoke('shell:showInFolder', file),
  startJob: (files, options) => ipcRenderer.invoke('job:start', { files, options }),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onJobEvent: (cb) => ipcRenderer.on('job:event', (_e, evt) => cb(evt)),
  onJobLog: (cb) => ipcRenderer.on('job:log', (_e, line) => cb(line)),
  onJobExit: (cb) => ipcRenderer.on('job:exit', (_e, info) => cb(info)),
});
