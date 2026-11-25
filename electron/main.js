import { app, BrowserWindow, dialog, powerSaveBlocker, safeStorage, session, shell, systemPreferences } from "electron";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { startServer } from "../src/server.js";

const PREFERRED_PORT = Number(process.env.PORT) || 4949;
// Same settings folder whether run from source or installed under the product name.
// The keychain entry is named after the app, so installed and source copies must
// share one name to read the same saved keys. The visible name is still "Speak To All".
app.setName("speaktoall-local");
// SPEAKTOALL_DATA_DIR runs a separate copy, e.g. for testing next to a running one.
app.setPath("userData", process.env.SPEAKTOALL_DATA_DIR || join(app.getPath("appData"), "speaktoall-local"));
let server;
let window;

async function startOnFreePort(store) {
  for (let port = PREFERRED_PORT; port < PREFERRED_PORT + 10; port++) {
    try {
      return await startServer({ store, port });
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`Ports ${PREFERRED_PORT}-${PREFERRED_PORT + 9} are all in use.`);
}

// Stored key formats: "enc2:" async keychain encryption, "enc:" the older sync
// encryption (re-saved as enc2 on load), otherwise plain text (no keychain available).
async function createStoreWithKeychain() {
  const available = await safeStorage.isAsyncEncryptionAvailable();
  return createStore({
    file: join(app.getPath("userData"), "settings.json"),
    async encrypt(value) {
      return available ? `enc2:${(await safeStorage.encryptStringAsync(value)).toString("base64")}` : value;
    },
    async decrypt(value) {
      if (value.startsWith("enc2:")) {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(value.slice(5), "base64"));
        return { value: result, stale: shouldReEncrypt };
      }
      if (value.startsWith("enc:")) {
        return { value: safeStorage.decryptString(Buffer.from(value.slice(4), "base64")), stale: available };
      }
      return { value, stale: available };
    },
  });
}

async function createWindow() {
  const origin = `http://localhost:${server.port}`;
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(permission === "media" && details.requestingUrl.startsWith(origin));
  });

  window = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 380,
    title: "Speak To All",
    backgroundColor: "#0f1115",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Links (API key pages, listener URLs) open in the regular browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  await window.loadURL(`${origin}/host`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });

  app.whenReady().then(async () => {
    try {
      server = await startOnFreePort(await createStoreWithKeychain());
      // Don't block startup on the permission prompt; capture waits for it anyway.
      if (process.platform === "darwin") systemPreferences.askForMediaAccess("microphone").catch(() => {});
      // Keep translating if the screen locks during a long service.
      powerSaveBlocker.start("prevent-app-suspension");
      await createWindow();
    } catch (error) {
      dialog.showErrorBox("Speak To All could not start", error.message);
      app.quit();
    }
  });

  app.on("activate", () => {
    if (server && BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Listeners depend on this process, so closing the window quits everywhere.
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => server?.close());
}
