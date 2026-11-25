import { app, BrowserWindow, dialog, powerSaveBlocker, safeStorage, session, shell, systemPreferences } from "electron";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { startServer } from "../src/server.js";

const PREFERRED_PORT = Number(process.env.PORT) || 4949;
// Running from source (`npm start`) keeps its own settings and never touches the
// keychain: unsigned dev builds would trigger a macOS keychain prompt constantly.
const isDev = !app.isPackaged;
// SPEAKTOALL_DATA_DIR runs a separate copy, e.g. for testing next to a running one.
app.setPath("userData", process.env.SPEAKTOALL_DATA_DIR ||
  join(app.getPath("appData"), isDev ? "speaktoall-local-dev" : "speaktoall-local"));
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

// Installed app: keys are encrypted with the OS keychain ("enc2:" prefix). The
// keychain is only touched when a key is actually read or saved.
// From source: keys are saved unencrypted in an owner-only file, or come from
// OPENAI_API_KEY / DEEPGRAM_API_KEY.
async function openStore() {
  const file = join(app.getPath("userData"), "settings.json");
  if (isDev) return createStore({ file });
  let available;
  const keychainAvailable = async () => (available ??= await safeStorage.isAsyncEncryptionAvailable());
  return createStore({
    file,
    async encrypt(value) {
      return await keychainAvailable()
        ? `enc2:${(await safeStorage.encryptStringAsync(value)).toString("base64")}`
        : value;
    },
    async decrypt(value) {
      if (!value.startsWith("enc2:")) return { value, stale: await keychainAvailable() };
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(value.slice(5), "base64"));
      return { value: result, stale: shouldReEncrypt };
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
      server = await startOnFreePort(await openStore());
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
