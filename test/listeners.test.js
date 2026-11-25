// End-to-end: one host, several phones on different languages, fake providers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createStore } from "../src/store.js";
import { startServer } from "../src/server.js";
import { languageName } from "../public/languages.js";

const CODES = Object.fromEntries(["es", "uk", "fr", "ko"].map((code) => [languageName(code), code]));
const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, what = "condition") {
  for (let i = 0; i < 200; i++) {
    const value = check();
    if (value) return value;
    await pause(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function setup({ languages = ["es", "uk", "fr"] } = {}) {
  const store = await createStore({ file: join(mkdtempSync(join(tmpdir(), "speaktoall-")), "s.json"), env: {} });
  await store.update({ openaiKey: "sk", deepgramKey: "dg", outputLanguages: languages, inputLanguage: "en-US" });
  const calls = { translate: [], speech: [] };
  const gates = {}; // language code -> promise that holds that language's translations
  let transcribe;
  const providers = {
    openTranscriptionStream({ onTranscript }) {
      transcribe = onTranscript;
      return { send() {}, close() {} };
    },
    async translateText({ to, text }) {
      const code = CODES[to];
      calls.translate.push(code);
      await gates[code];
      return `${code}:${text}`;
    },
    async synthesizeSpeech({ text }) {
      calls.speech.push(text.split(":")[0]);
      return Buffer.from(text);
    },
  };
  const app = await startServer({ store, port: 0, host: "127.0.0.1", providers, updates: { check: async () => ({}) } });
  const base = `http://127.0.0.1:${app.port}`;
  const sockets = [];

  async function connect(path, options) {
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}${path}`, options);
    const messages = [];
    ws.on("message", (data) => messages.push(JSON.parse(data)));
    await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
    sockets.push(ws);
    return { ws, messages, of: (type) => messages.filter((m) => m.type === type) };
  }

  const host = await connect("/ws/host", { origin: base });
  const listenerCount = () => host.of("listeners").at(-1);

  return {
    app, store, calls, gates, host,
    say: (text) => transcribe(text, true),
    async start() {
      host.ws.send(JSON.stringify({ type: "start" }));
      await waitFor(() => host.of("state").some((m) => m.running), "broadcast start");
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      await app.close();
    },
    listenerCount,
    connect,
    async selectAndWait(phone, language, audio) {
      const before = host.of("listeners").length;
      phone.ws.send(JSON.stringify({ type: "select", language, audio }));
      await waitFor(() => host.of("listeners").length > before, "listener update");
    },
  };
}

// Connects phones that each pick a language and optionally turn on sound.
async function phonesFor(env, specs) {
  const phones = [];
  for (const [language, audio] of specs) {
    const phone = await env.connect("/ws/listen");
    await env.selectAndWait(phone, language, audio);
    phones.push(phone);
  }
  return phones;
}

test("each phone gets captions only in its own language, and audio only if it asked", async () => {
  const env = await setup();
  try {
    await env.start();
    const [esText, ukAudio, esAudio] = await phonesFor(env, [["es", false], ["uk", true], ["es", true]]);
    assert.deepEqual(env.listenerCount().byLanguage, { es: { listeners: 2, audio: 1 }, uk: { listeners: 1, audio: 1 } });

    env.say("Hello church.");
    await waitFor(() => ukAudio.of("audio").length && esAudio.of("audio").length, "audio");
    await pause();

    assert.deepEqual(esText.of("caption").map((m) => m.text), ["es:Hello church."]);
    assert.equal(esText.of("audio").length, 0);
    assert.deepEqual(ukAudio.of("caption").map((m) => m.text), ["uk:Hello church."]);
    assert.deepEqual(ukAudio.of("audio").map((m) => Buffer.from(m.audio, "base64").toString()), ["uk:Hello church."]);
    assert.deepEqual(esAudio.of("caption").map((m) => m.text), ["es:Hello church."]);
    assert.equal(esAudio.of("audio").length, 1);
    // French is enabled but nobody chose it, so it costs nothing.
    assert.deepEqual(env.calls.translate.sort(), ["es", "uk"]);
    // One speech request per language, shared by everyone listening to it.
    assert.deepEqual(env.calls.speech.sort(), ["es", "uk"]);
  } finally {
    await env.close();
  }
});

test("many phones on the same language share one translation", async () => {
  const env = await setup();
  try {
    await env.start();
    const phones = await phonesFor(env, Array.from({ length: 25 }, () => ["es", true]));
    env.say("Welcome.");
    await waitFor(() => phones.every((p) => p.of("audio").length === 1), "audio on every phone");
    assert.equal(env.calls.translate.length, 1);
    assert.equal(env.calls.speech.length, 1);
    assert.ok(phones.every((p) => p.of("caption")[0].text === "es:Welcome."));
  } finally {
    await env.close();
  }
});

test("switching language mid-service takes effect on the next sentence", async () => {
  const env = await setup();
  try {
    await env.start();
    const [phone] = await phonesFor(env, [["es", false]]);
    env.say("First.");
    await waitFor(() => phone.of("caption").length === 1, "first caption");
    await env.selectAndWait(phone, "uk", false);
    env.say("Second.");
    await waitFor(() => phone.of("caption").length === 2, "second caption");
    assert.deepEqual(phone.of("caption").map((m) => m.text), ["es:First.", "uk:Second."]);
  } finally {
    await env.close();
  }
});

test("turning sound off stops audio but keeps captions", async () => {
  const env = await setup();
  try {
    await env.start();
    const [phone] = await phonesFor(env, [["es", true]]);
    env.say("One.");
    await waitFor(() => phone.of("audio").length === 1, "first audio");
    await env.selectAndWait(phone, "es", false);
    env.say("Two.");
    await waitFor(() => phone.of("caption").length === 2, "second caption");
    await pause();
    assert.equal(phone.of("audio").length, 1);
    assert.equal(env.calls.speech.length, 1);
  } finally {
    await env.close();
  }
});

test("when the last listener of a language leaves, it stops being translated", async () => {
  const env = await setup();
  try {
    await env.start();
    const [esPhone, ukPhone] = await phonesFor(env, [["es", false], ["uk", false]]);
    env.say("Before.");
    await waitFor(() => ukPhone.of("caption").length === 1, "uk caption");
    const before = env.host.of("listeners").length;
    ukPhone.ws.close();
    await waitFor(() => env.host.of("listeners").length > before, "listener left");
    env.calls.translate.length = 0;
    env.say("After.");
    await waitFor(() => esPhone.of("caption").length === 2, "es caption");
    await pause();
    assert.deepEqual(env.calls.translate, ["es"]);
  } finally {
    await env.close();
  }
});

test("a slow language does not hold up the others", async () => {
  const env = await setup();
  try {
    await env.start();
    let releaseUkrainian;
    env.gates.uk = new Promise((resolve) => { releaseUkrainian = resolve; });
    const [esPhone, ukPhone] = await phonesFor(env, [["es", true], ["uk", true]]);
    env.say("One.");
    env.say("Two.");
    await waitFor(() => esPhone.of("audio").length === 2, "spanish audio");
    assert.equal(ukPhone.of("caption").length, 0);
    releaseUkrainian();
    await waitFor(() => ukPhone.of("audio").length === 2, "ukrainian audio");
    assert.deepEqual(ukPhone.of("caption").map((m) => m.text), ["uk:One.", "uk:Two."]);
  } finally {
    await env.close();
  }
});

test("phones cannot pick a language the host has not enabled", async () => {
  const env = await setup({ languages: ["es"] });
  try {
    await env.start();
    const [phone] = await phonesFor(env, [["ko", true]]);
    assert.deepEqual(env.listenerCount().byLanguage, {});
    env.say("Hello.");
    await pause(150);
    assert.equal(phone.of("caption").length, 0);
    assert.deepEqual(env.calls.translate, ["es"]); // only the host preview
  } finally {
    await env.close();
  }
});

test("phones see language changes and a new session when the host restarts", async () => {
  const env = await setup();
  try {
    await env.start();
    const [phone] = await phonesFor(env, [["es", false]]);
    const firstSession = phone.of("state").at(-1).sessionId;

    await fetch(`http://127.0.0.1:${env.app.port}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outputLanguages: ["es", "ko"] }),
    });
    await waitFor(() => phone.of("state").at(-1).languages.includes("ko"), "language list update");

    env.host.ws.send(JSON.stringify({ type: "stop" }));
    await waitFor(() => phone.of("state").at(-1).running === false, "stop");
    await env.start();
    await waitFor(() => phone.of("state").at(-1).running, "restart");
    assert.notEqual(phone.of("state").at(-1).sessionId, firstSession);
  } finally {
    await env.close();
  }
});

test("a phone that joins late is told the broadcast is live", async () => {
  const env = await setup();
  try {
    await env.start();
    const late = await env.connect("/ws/listen");
    const state = await waitFor(() => late.of("state")[0], "initial state");
    assert.equal(state.running, true);
    assert.deepEqual(state.languages, ["es", "uk", "fr"]);
  } finally {
    await env.close();
  }
});
