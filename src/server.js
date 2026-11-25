// One HTTP + WebSocket server on the local network.
//   /host, /api/*, /ws/host  -> only from this computer (controls keys and spending)
//   /, /display, /ws/listen  -> anyone on the same WiFi
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import QRCode from "qrcode";
import { Broadcast } from "./broadcast.js";
import { realProviders, verifyKeys } from "./providers.js";
import { defaultUpdateChecker } from "./updates.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MAX_LISTENERS = 1000;
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const PAGES = { "/": "listen.html", "/display": "display.html", "/host": "host.html" };
const HOST_ONLY_PAGES = new Set(["/host"]);
// Caption displays may be embedded in OBS, ProPresenter, or other pages; nothing else may be.
const EMBEDDABLE_PAGES = new Set(["/display"]);
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' data: blob:; object-src 'none'";

export function isLoopback(address = "") {
  return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

// Guards against other websites in the host's browser and DNS rebinding.
function isTrustedLocalRequest(req, port) {
  if (!isLoopback(req.socket.remoteAddress)) return false;
  const allowed = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (!allowed.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || allowed.some((host) => origin === `http://${host}`);
}

export function lanAddresses() {
  const addresses = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push({ name, address: entry.address });
    }
  }
  // Wi-Fi/Ethernet adapters first, virtual adapters (VPNs, Docker) last.
  const rank = ({ name }) => (/^(en|eth|wlan|wl|Wi-?Fi|Ethernet)/i.test(name) ? 0 : 1);
  return addresses.sort((a, b) => rank(a) - rank(b));
}

function readStaticFiles() {
  const files = new Map();
  for (const name of readdirSync(PUBLIC_DIR)) {
    const type = CONTENT_TYPES[extname(name)];
    if (type) files.set(name, { type, body: readFileSync(join(PUBLIC_DIR, name)) });
  }
  return files;
}

async function readJson(req, limit = 16_384) {
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new Error("Request too large");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function startServer({ store, port = 4949, host = "0.0.0.0", providers = realProviders, verify = verifyKeys, updates = defaultUpdateChecker() }) {
  const files = readStaticFiles();
  const listeners = new Set();
  const hosts = new Set();
  let actualPort = port;

  const broadcast = new Broadcast({
    providers,
    getSettings: () => store.get(),
    getDemand() {
      const captions = new Set();
      const audio = new Set();
      for (const socket of listeners) {
        if (!socket.language) continue;
        captions.add(socket.language);
        if (socket.wantsAudio) audio.add(socket.language);
      }
      return { captions, audio };
    },
  });

  const sendTo = (sockets, message) => {
    const data = JSON.stringify(message);
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(data);
  };

  function listenerSummary() {
    const byLanguage = {};
    for (const socket of listeners) {
      if (!socket.language) continue;
      byLanguage[socket.language] ??= { listeners: 0, audio: 0 };
      byLanguage[socket.language].listeners++;
      if (socket.wantsAudio) byLanguage[socket.language].audio++;
    }
    return { type: "listeners", total: listeners.size, byLanguage };
  }

  broadcast.on("state", (state) => {
    sendTo(hosts, { type: "state", ...state });
    sendTo(listeners, { type: "state", ...state });
  });
  broadcast.on("notice", (notice) => sendTo(hosts, { type: "notice", ...notice }));
  broadcast.on("transcript", (transcript) => sendTo(hosts, { type: "transcript", ...transcript }));
  broadcast.on("caption", (caption) => {
    sendTo(hosts, { type: "caption", ...caption });
    sendTo([...listeners].filter((socket) => socket.language === caption.language), { type: "caption", ...caption });
  });
  broadcast.on("audio", ({ audio, ...rest }) => {
    const targets = [...listeners].filter((socket) => socket.wantsAudio && socket.language === rest.language);
    sendTo(targets, { type: "audio", ...rest, audio: audio.toString("base64") });
  });

  async function shareLinks() {
    return Promise.all(lanAddresses().map(async ({ name, address }) => {
      const url = `http://${address}:${actualPort}/`;
      return { name, url, displayUrl: `${url}display`, qrSvg: await QRCode.toString(url, { type: "svg", margin: 1 }) };
    }));
  }

  async function handleApi(req, res, pathname) {
    if (pathname === "/api/settings" && req.method === "GET") {
      return sendJson(res, 200, store.publicView());
    }
    if (pathname === "/api/settings" && req.method === "POST") {
      const changes = await store.update(await readJson(req));
      broadcast.settingsChanged(changes);
      return sendJson(res, 200, store.publicView());
    }
    if (pathname === "/api/verify-keys" && req.method === "POST") {
      const { openaiKey, deepgramKey } = store.get();
      return sendJson(res, 200, await verify({ openaiKey, deepgramKey }));
    }
    if (pathname === "/api/update" && req.method === "GET") {
      return sendJson(res, 200, await updates.check());
    }
    if (pathname === "/api/share" && req.method === "GET") {
      return sendJson(res, 200, { links: await shareLinks(), localUrl: `http://localhost:${actualPort}/` });
    }
    sendJson(res, 404, { error: "Not found" });
  }

  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      const hostOnly = HOST_ONLY_PAGES.has(pathname) || pathname.startsWith("/api/");
      if (hostOnly && !isTrustedLocalRequest(req, actualPort)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        return res.end("The host controls are only available on the broadcasting computer.");
      }
      if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname);

      const name = PAGES[pathname] || (pathname.startsWith("/assets/") && pathname.slice("/assets/".length));
      const file = name && files.get(name);
      if (!file || req.method !== "GET") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("Not found");
      }
      res.writeHead(200, {
        "Content-Type": file.type,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": EMBEDDABLE_PAGES.has(pathname) ? CSP : `${CSP}; frame-ancestors 'none'`,
      });
      res.end(file.body);
    } catch (error) {
      console.error("Request failed:", error);
      if (!res.headersSent) sendJson(res, 400, { error: error.message });
      else res.end();
    }
  });

  const hostSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const listenerSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/ws/host" && isTrustedLocalRequest(req, actualPort)) {
      hostSockets.handleUpgrade(req, socket, head, (ws) => hostSockets.emit("connection", ws, req));
    } else if (pathname === "/ws/listen" && listeners.size < MAX_LISTENERS) {
      listenerSockets.handleUpgrade(req, socket, head, (ws) => listenerSockets.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  hostSockets.on("connection", (ws) => {
    hosts.add(ws);
    ws.send(JSON.stringify({ type: "state", ...broadcast.state }));
    ws.send(JSON.stringify(listenerSummary()));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return broadcast.pushAudio(data);
      let message;
      try { message = JSON.parse(data); } catch { return; }
      try {
        if (message.type === "start") broadcast.start();
        if (message.type === "stop") broadcast.stop();
      } catch (error) {
        ws.send(JSON.stringify({ type: "notice", level: "error", message: error.message }));
      }
    });
    ws.on("close", () => hosts.delete(ws));
  });

  listenerSockets.on("connection", (ws) => {
    ws.language = null;
    ws.wantsAudio = false;
    listeners.add(ws);
    ws.send(JSON.stringify({ type: "state", ...broadcast.state }));
    ws.on("message", (data) => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.type !== "select") return;
      const { languages } = broadcast.state;
      ws.language = languages.includes(message.language) ? message.language : null;
      ws.wantsAudio = Boolean(message.audio) && Boolean(ws.language);
      sendTo(hosts, listenerSummary());
    });
    ws.on("close", () => {
      listeners.delete(ws);
      sendTo(hosts, listenerSummary());
    });
  });

  // Listener sockets go quiet on sleeping phones; ping to clean them up.
  const heartbeat = setInterval(() => {
    for (const ws of listeners) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  listenerSockets.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      actualPort = server.address().port;
      resolve();
    });
  });

  return {
    port: actualPort,
    broadcast,
    shareLinks,
    async close() {
      clearInterval(heartbeat);
      broadcast.stop();
      for (const ws of [...hosts, ...listeners]) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
