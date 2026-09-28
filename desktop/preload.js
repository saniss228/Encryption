/* Мост между оболочкой Electron и веб-клиентом. Node наружу не отдаём. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('NATIVE_APP', {
  kind: 'desktop',
  platform: process.platform,
  version: process.versions.electron,
  getInfo: () => ipcRenderer.invoke('app-info'),
  setServer: (url) => ipcRenderer.invoke('set-server', url),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  notify: (title, body) => ipcRenderer.invoke('notify', { title, body }),
});

// Адрес сервера можно передать строкой запроса: index.html?server=http://...
try {
  const params = new URLSearchParams(location.search);
  const server = params.get('server');
  if (server) window.__SERVER_BASE__ = server;
} catch (e) { /* noop */ }
