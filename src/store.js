// Settings live in one JSON file on this computer. API keys are encrypted with
// the OS keychain when running in Electron (see electron/main.js).
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_MODELS } from "./providers.js";
import { INPUT_LANGUAGES, OUTPUT_LANGUAGES, TTS_VOICES } from "../public/languages.js";

const DEFAULTS = Object.freeze({
  inputLanguage: "en-US",
  outputLanguages: ["es"],
  voice: "nova",
  transcriptionModel: DEFAULT_MODELS.transcription,
  translationModel: DEFAULT_MODELS.translation,
  speechModel: DEFAULT_MODELS.speech,
});

const MODEL_PATTERN = /^[\w.:-]{1,80}$/;

export function createStore({ file, encrypt = (value) => value, decrypt = (value) => value, env = process.env }) {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`Ignoring unreadable settings file ${file}: ${error.message}`);
  }

  function readKey(name) {
    if (!saved[name]) return "";
    try { return decrypt(saved[name]); } catch { return ""; }
  }

  function persist() {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(saved, null, 2), { mode: 0o600 });
    renameSync(temp, file);
  }

  return {
    // Full settings including keys. Never send this to a browser.
    get() {
      return {
        ...DEFAULTS,
        ...saved,
        openaiKey: env.OPENAI_API_KEY || readKey("openaiKey"),
        deepgramKey: env.DEEPGRAM_API_KEY || readKey("deepgramKey"),
      };
    },

    publicView() {
      const { openaiKey, deepgramKey, ...rest } = this.get();
      return { ...rest, hasOpenaiKey: Boolean(openaiKey), hasDeepgramKey: Boolean(deepgramKey) };
    },

    // Applies only recognized, valid fields. An empty key string removes that key.
    update(patch) {
      const before = this.get();
      for (const name of ["openaiKey", "deepgramKey"]) {
        if (typeof patch[name] !== "string") continue;
        const key = patch[name].trim();
        if (key) saved[name] = encrypt(key);
        else delete saved[name];
      }
      if (INPUT_LANGUAGES.includes(patch.inputLanguage)) saved.inputLanguage = patch.inputLanguage;
      if (Array.isArray(patch.outputLanguages)) {
        saved.outputLanguages = [...new Set(patch.outputLanguages)]
          .filter((language) => OUTPUT_LANGUAGES.includes(language));
      }
      if (TTS_VOICES.some((voice) => voice.value === patch.voice)) saved.voice = patch.voice;
      for (const name of ["transcriptionModel", "translationModel", "speechModel"]) {
        if (typeof patch[name] !== "string") continue;
        const model = patch[name].trim();
        if (!model) delete saved[name];
        else if (MODEL_PATTERN.test(model)) saved[name] = model;
      }
      persist();
      const after = this.get();
      return {
        transcriptionChanged: ["inputLanguage", "transcriptionModel", "deepgramKey"]
          .some((name) => before[name] !== after[name]),
      };
    },
  };
}
