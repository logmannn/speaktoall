import { test } from "node:test";
import assert from "node:assert/strict";
import { Broadcast } from "../src/broadcast.js";
import { splitTranslationChunks } from "../src/chunks.js";

function setup({ demand = { captions: new Set(), audio: new Set() }, settings = {} } = {}) {
  const calls = { translate: [], speech: [] };
  let transcribe;
  const speechResolvers = [];
  const providers = {
    openTranscriptionStream({ onTranscript }) {
      transcribe = onTranscript;
      return { send() {}, close() {} };
    },
    async translateText(args) {
      calls.translate.push(args);
      return `[${args.to}] ${args.text}`;
    },
    synthesizeSpeech({ text }) {
      calls.speech.push(text);
      return new Promise((resolve) => speechResolvers.push(() => resolve(Buffer.from(text))));
    },
  };
  const broadcast = new Broadcast({
    providers,
    getSettings: () => ({
      openaiKey: "sk", deepgramKey: "dg", inputLanguage: "en-US", outputLanguages: ["es", "uk"],
      voice: "nova", translationModel: "m", speechModel: "s", transcriptionModel: "t", ...settings,
    }),
    getDemand: () => demand,
  });
  const events = { caption: [], audio: [], notice: [] };
  for (const name of Object.keys(events)) broadcast.on(name, (event) => events[name].push(event));
  broadcast.start();
  return { broadcast, calls, events, speechResolvers, say: (text) => transcribe(text, true) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("translates only the first language when nobody is listening", async () => {
  const { calls, events, say } = setup();
  say("Good morning everyone.");
  await flush();
  assert.deepEqual(calls.translate.map((call) => call.to), ["Spanish"]);
  assert.equal(events.caption[0].text, "[Spanish] Good morning everyone.");
});

test("translates every language with listeners and skips speech for caption-only listeners", async () => {
  const { calls, events, say } = setup({ demand: { captions: new Set(["es", "uk"]), audio: new Set() } });
  say("Welcome.");
  await flush();
  assert.deepEqual(calls.translate.map((call) => call.to).sort(), ["Spanish", "Ukrainian"]);
  assert.equal(events.caption.length, 2);
  assert.equal(calls.speech.length, 0);
});

test("passes through the same language without calling the model", async () => {
  const { calls, events, say } = setup({ settings: { outputLanguages: ["en"] } });
  say("Hello.");
  await flush();
  assert.equal(calls.translate.length, 0);
  assert.equal(events.caption[0].text, "Hello.");
});

test("releases speech in transcript order even when synthesis finishes out of order", async () => {
  const demand = { captions: new Set(["es"]), audio: new Set(["es"]) };
  const { events, speechResolvers, say } = setup({ demand });
  say("First.");
  say("Second.");
  await flush(); await flush();
  assert.equal(speechResolvers.length, 2);
  speechResolvers[1]();
  await flush();
  assert.equal(events.audio.length, 0);
  speechResolvers[0]();
  await flush();
  assert.deepEqual(events.audio.map((event) => event.seq), [0, 1]);
});

test("stopping discards in-flight work", async () => {
  const demand = { captions: new Set(["es"]), audio: new Set(["es"]) };
  const { broadcast, events, speechResolvers, say } = setup({ demand });
  say("Hello.");
  await flush();
  broadcast.stop();
  speechResolvers.forEach((resolve) => resolve());
  await flush();
  assert.equal(events.audio.length, 0);
});

test("an OpenAI auth failure stops the broadcast with an error", async () => {
  const { broadcast, events, say } = setup();
  broadcast.providers.translateText = async () => {
    throw Object.assign(new Error("Incorrect API key"), { isAuthError: true });
  };
  say("Hello.");
  await flush();
  assert.equal(broadcast.running, false);
  assert.equal(events.notice[0].level, "error");
});

test("splits long transcripts at nearby boundaries", () => {
  const text = "word ".repeat(60).trim();
  const chunks = splitTranslationChunks(text, 120);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 120));
  assert.equal(chunks.join(" "), text);
});
