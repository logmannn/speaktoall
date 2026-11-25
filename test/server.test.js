import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createStore } from "../src/store.js";
import { startServer } from "../src/server.js";

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "speaktoall-"));
  const file = join(dir, "settings.json");
  const store = await createStore({ file, env: {}, encrypt: async (value) => `enc:${value}`, decrypt: async (value) => ({ value: value.slice(4), stale: false }) });
  let transcribe;
  const providers = {
    openTranscriptionStream({ onTranscript }) {
      transcribe = onTranscript;
      return { send() {}, close() {} };
    },
    translateText: async ({ text }) => `es:${text}`,
    synthesizeSpeech: async ({ text }) => Buffer.from(text),
  };
  const app = await startServer({ store, port: 0, host: "127.0.0.1", providers });
  return { app, store, file, base: `http://127.0.0.1:${app.port}`, say: (text) => transcribe(text, true) };
}

function open(url, options) {
  const ws = new WebSocket(url, options);
  const messages = [];
  ws.on("message", (data) => messages.push(JSON.parse(data)));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

const waitFor = async (check) => {
  for (let i = 0; i < 100; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out");
};

test("never returns API keys to the browser and encrypts them on disk", async () => {
  const { app, base, file } = await setup();
  try {
    const response = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openaiKey: "sk-secret", deepgramKey: "dg-secret", outputLanguages: ["es", "xx"] }),
    });
    const body = await response.json();
    assert.equal(body.hasOpenaiKey, true);
    assert.equal(body.openaiKey, undefined);
    assert.deepEqual(body.outputLanguages, ["es"]);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).openaiKey, "enc:sk-secret");
  } finally {
    await app.close();
  }
});

test("rejects host API calls from other websites", async () => {
  const { app, base } = await setup();
  try {
    const response = await fetch(`${base}/api/settings`, { headers: { Origin: "https://evil.example" } });
    assert.equal(response.status, 403);
    await assert.rejects(open(`ws://127.0.0.1:${app.port}/ws/host`, { origin: "https://evil.example" }));
  } finally {
    await app.close();
  }
});

test("serves only known files", async () => {
  const { app, base } = await setup();
  try {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/assets/listen.js`)).status, 200);
    assert.equal((await fetch(`${base}/assets/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
  } finally {
    await app.close();
  }
});

test("only the caption display can be embedded in other apps", async () => {
  const { app, base } = await setup();
  try {
    const display = (await fetch(`${base}/display`)).headers.get("content-security-policy");
    const listen = (await fetch(`${base}/`)).headers.get("content-security-policy");
    assert.ok(!display.includes("frame-ancestors"));
    assert.ok(listen.includes("frame-ancestors 'none'"));
  } finally {
    await app.close();
  }
});

test("delivers captions and ordered audio from host to listeners", async () => {
  const { app, base, store, say } = await setup();
  try {
    await store.update({ openaiKey: "sk", deepgramKey: "dg", outputLanguages: ["es"] });
    const host = await open(`ws://127.0.0.1:${app.port}/ws/host`, { origin: base });
    const listener = await open(`ws://127.0.0.1:${app.port}/ws/listen`);
    host.ws.send(JSON.stringify({ type: "start" }));
    await waitFor(() => listener.messages.find((m) => m.type === "state" && m.running));
    listener.ws.send(JSON.stringify({ type: "select", language: "es", audio: true }));
    await waitFor(() => host.messages.find((m) => m.type === "listeners" && m.byLanguage.es?.audio === 1));

    say("Hello.");
    const caption = await waitFor(() => listener.messages.find((m) => m.type === "caption"));
    assert.equal(caption.text, "es:Hello.");
    const audio = await waitFor(() => listener.messages.find((m) => m.type === "audio"));
    assert.equal(Buffer.from(audio.audio, "base64").toString(), "es:Hello.");
    assert.ok(host.messages.some((m) => m.type === "transcript" && m.final && m.text === "Hello."));
    host.ws.close();
    listener.ws.close();
  } finally {
    await app.close();
  }
});
