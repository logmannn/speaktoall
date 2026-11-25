// Speech -> transcript -> per-language translation -> optional speech.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { splitTranslationChunks } from "./chunks.js";
import { baseLanguage, languageName } from "../public/languages.js";

const CHUNK_CHARACTERS = 120;
const CONTEXT_CHARACTERS = 600;
const MAX_PENDING_TRANSLATIONS = 60;

// Events:
//   "state"      -> public broadcast state changed
//   "transcript" -> { seq, text, final: true } per chunk, or { text, final: false } while speaking
//   "caption"    -> { sessionId, seq, language, text }
//   "audio"      -> { sessionId, seq, language, audio }  (audio is a Buffer, released in order)
//   "notice"     -> { level: "warning" | "error", message }
export class Broadcast extends EventEmitter {
  constructor({ providers, getSettings, getDemand }) {
    super();
    this.providers = providers;
    this.getSettings = getSettings;
    // Returns { captions: Set<language>, audio: Set<language> } for connected listeners.
    this.getDemand = getDemand;
    this.running = false;
    this.sessionId = randomUUID();
    this.generation = 0;
    this.stream = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.resetSession();
  }

  resetSession() {
    this.seq = 0;
    this.context = "";
    this.queues = new Map();
    this.pendingAudio = new Map();
    this.pendingTranslations = 0;
  }

  get state() {
    const settings = this.getSettings();
    return {
      running: this.running,
      sessionId: this.sessionId,
      inputLanguage: settings.inputLanguage,
      languages: settings.outputLanguages,
    };
  }

  start() {
    if (this.running) return;
    const settings = this.getSettings();
    if (!settings.openaiKey || !settings.deepgramKey) {
      throw new Error("Add your OpenAI and Deepgram API keys first.");
    }
    if (!settings.outputLanguages.length) throw new Error("Choose at least one output language.");
    this.running = true;
    this.generation++;
    this.sessionId = randomUUID();
    this.resetSession();
    this.reconnectAttempts = 0;
    this.openStream();
    this.emit("state", this.state);
  }

  stop(notice) {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    this.stream?.close();
    this.stream = null;
    this.resetSession();
    if (notice) this.emit("notice", notice);
    this.emit("state", this.state);
  }

  // Transcription changes need a new stream; other settings apply live.
  settingsChanged({ transcriptionChanged }) {
    if (this.running && transcriptionChanged) {
      this.context = "";
      this.stream?.close();
      this.openStream();
    }
    this.emit("state", this.state);
  }

  pushAudio(buffer) {
    if (this.running) this.stream?.send(buffer);
  }

  openStream() {
    const settings = this.getSettings();
    const generation = this.generation;
    const stream = this.providers.openTranscriptionStream({
      apiKey: settings.deepgramKey,
      model: settings.transcriptionModel,
      language: settings.inputLanguage,
      onTranscript: (text, final) => {
        if (generation !== this.generation || stream !== this.stream) return;
        this.reconnectAttempts = 0;
        if (final) this.handleFinalTranscript(text);
        else this.emit("transcript", { text, final: false });
      },
      onError: (error) => {
        if (generation !== this.generation || stream !== this.stream) return;
        if (error.isAuthError) {
          this.stop({ level: "error", message: `${error.message}. Check your Deepgram key.` });
        } else {
          this.emit("notice", { level: "warning", message: `Transcription: ${error.message}` });
        }
      },
      onClose: ({ expected }) => {
        if (expected || generation !== this.generation || stream !== this.stream || !this.running) return;
        const delay = Math.min(10000, 500 * 2 ** this.reconnectAttempts++);
        this.emit("notice", { level: "warning", message: "Transcription connection dropped. Reconnecting…" });
        this.reconnectTimer = setTimeout(() => {
          if (this.running && generation === this.generation) this.openStream();
        }, delay);
      },
    });
    this.stream = stream;
  }

  handleFinalTranscript(text) {
    for (const chunk of splitTranslationChunks(text, CHUNK_CHARACTERS)) this.processChunk(chunk);
  }

  processChunk(text) {
    const settings = this.getSettings();
    const context = this.context;
    this.context = `${context} ${text}`.trim().slice(-CONTEXT_CHARACTERS);
    const seq = this.seq++;
    const demand = this.getDemand();
    this.emit("transcript", { seq, text, final: true });

    // Only spend on languages someone is listening to, but always translate the
    // first language so the host can see the broadcast working.
    let targets = settings.outputLanguages.filter((language) =>
      demand.captions.has(language) || demand.audio.has(language));
    if (!targets.length) targets = settings.outputLanguages.slice(0, 1);

    for (const language of targets) {
      const wantsAudio = demand.audio.has(language);
      if (wantsAudio) this.audioQueueFor(language).set(seq, undefined);
      this.enqueue(language, () => this.translate({ language, text, context, seq, wantsAudio }));
    }
  }

  enqueue(language, task) {
    if (this.pendingTranslations >= MAX_PENDING_TRANSLATIONS) {
      this.emit("notice", { level: "warning", message: "Translation is falling behind; skipping some speech to catch up." });
      this.audioQueueFor(language).clear();
      return;
    }
    const generation = this.generation;
    this.pendingTranslations++;
    const previous = this.queues.get(language) || Promise.resolve();
    const next = previous
      .then(() => generation === this.generation && task())
      .catch((error) => console.error("Translation queue error:", error))
      .finally(() => {
        if (generation !== this.generation) return;
        this.pendingTranslations--;
        if (this.queues.get(language) === next) this.queues.delete(language);
      });
    this.queues.set(language, next);
  }

  async translate({ language, text, context, seq, wantsAudio }) {
    const settings = this.getSettings();
    const generation = this.generation;
    let translation;
    try {
      translation = baseLanguage(settings.inputLanguage) === baseLanguage(language)
        ? text
        : await this.providers.translateText({
          apiKey: settings.openaiKey,
          model: settings.translationModel,
          from: languageName(settings.inputLanguage),
          to: languageName(language),
          context,
          text,
        });
    } catch (error) {
      if (generation !== this.generation) return;
      if (wantsAudio) this.releaseAudio(language, seq, null);
      if (error.isAuthError) {
        this.stop({ level: "error", message: `OpenAI rejected the request: ${error.message}` });
      } else {
        this.emit("notice", { level: "warning", message: `Translation to ${languageName(language)} failed: ${error.message}` });
      }
      return;
    }
    if (generation !== this.generation) return;
    this.emit("caption", { sessionId: this.sessionId, seq, language, text: translation });
    if (wantsAudio) this.speak({ language, text: translation, seq, generation });
  }

  // Speech requests run in parallel but are released in transcript order.
  async speak({ language, text, seq, generation }) {
    const settings = this.getSettings();
    let audio = null;
    try {
      audio = await this.providers.synthesizeSpeech({
        apiKey: settings.openaiKey,
        model: settings.speechModel,
        voice: settings.voice,
        text,
      });
    } catch (error) {
      if (generation === this.generation) {
        this.emit("notice", { level: "warning", message: `Speech for ${languageName(language)} failed: ${error.message}` });
      }
    }
    if (generation === this.generation) this.releaseAudio(language, seq, audio);
  }

  audioQueueFor(language) {
    if (!this.pendingAudio.has(language)) this.pendingAudio.set(language, new Map());
    return this.pendingAudio.get(language);
  }

  releaseAudio(language, seq, audio) {
    const queue = this.audioQueueFor(language);
    if (!queue.has(seq)) return;
    queue.set(seq, audio);
    for (const [pendingSeq, pendingAudio] of queue) {
      if (pendingAudio === undefined) break;
      queue.delete(pendingSeq);
      if (pendingAudio) {
        this.emit("audio", { sessionId: this.sessionId, seq: pendingSeq, language, audio: pendingAudio });
      }
    }
  }
}
