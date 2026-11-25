import { RTL_LANGUAGES, languageName } from "./languages.js";
import { PlaybackQueue } from "./playback.js";

const $ = (id) => document.getElementById(id);
const mode = document.body.dataset.mode; // "listen" (phones) or "display" (projector)
const params = new URLSearchParams(location.search);
let maxCaptions = 80;

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};

// Display options: ?language=es&theme=dark|light|transparent&fontSize=24-200&lines=1-10
// Transparent or embedded displays show captions only, for OBS/ProPresenter overlays.
if (mode === "display") {
  const theme = params.get("theme");
  if (["dark", "light", "transparent"].includes(theme)) document.body.dataset.theme = theme;
  const fontSize = Number(params.get("fontSize"));
  if (fontSize >= 24 && fontSize <= 200) document.documentElement.style.setProperty("--caption-size", `${fontSize}px`);
  const lines = Number(params.get("lines"));
  maxCaptions = Number.isInteger(lines) && lines >= 1 && lines <= 10 ? lines : 3;
  if (theme === "transparent" || window.self !== window.top) document.body.classList.add("bare");
}

const pinnedLanguage = params.get("language");
let language = pinnedLanguage || storage.get(`${mode}-language`);
let languages = [];
let live = false;
let sessionId = null;
let socket = null;
let retry = 0;

// ---------- Connection ----------

function connect() {
  socket = new WebSocket(`ws://${location.host}/ws/listen`);
  socket.onopen = () => { retry = 0; };
  socket.onmessage = ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.type === "state") onState(message);
    else if (message.type === "caption" && message.language === language) addCaption(message.text);
    else if (message.type === "audio" && message.language === language) audio.push(message.audio);
  };
  socket.onclose = () => {
    setStatus("Reconnecting…");
    setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
  };
}

function onState(state) {
  if (state.sessionId !== sessionId) {
    sessionId = state.sessionId;
    $("captions").replaceChildren();
    clearAudio();
  }
  live = state.running;
  languages = state.languages;
  if (language && !languages.includes(language) && !pinnedLanguage) language = null;
  if (!language && languages.length === 1) language = languages[0];
  if (!language && mode === "display" && !pinnedLanguage) language = languages[0] || null;
  render();
  sendSelection();
}

function sendSelection() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "select", language, audio: audio.enabled }));
}

function selectLanguage(code) {
  if (code !== language) {
    $("captions").replaceChildren();
    clearAudio();
  }
  language = code;
  storage.set(`${mode}-language`, code);
  $("picker").hidden = true;
  render();
  sendSelection();
}

// ---------- Rendering ----------

function setStatus(text, className = "pill") {
  $("status").textContent = text;
  $("status").className = className;
}

function render() {
  const available = language && languages.includes(language);
  $("picker").hidden = Boolean(available) || languages.length === 0;
  if (!$("picker").hidden) renderPicker();

  $("change-language").hidden = !available || languages.length < 2 || Boolean(pinnedLanguage);
  $("change-language").textContent = available ? `${languageName(language, language)} ▾` : "";
  if ($("controls")) $("controls").hidden = !available;

  if (available) {
    document.documentElement.lang = language;
    $("captions").dir = RTL_LANGUAGES.has(language.split("-")[0]) ? "rtl" : "ltr";
  }
  $("waiting").hidden = live && $("captions").children.length > 0;
  $("waiting").textContent = live ? "Listening for the speaker…" : "Waiting for the broadcast to start…";
  setStatus(live ? "Live" : "Not live", live ? "pill live" : "pill");
}

function renderPicker() {
  $("picker-options").replaceChildren(...languages.map((code) => {
    const button = document.createElement("button");
    button.type = "button";
    button.lang = code;
    button.append(languageName(code, code));
    const english = document.createElement("small");
    english.textContent = languageName(code);
    button.append(english);
    button.addEventListener("click", () => selectLanguage(code));
    return button;
  }));
}

$("change-language").addEventListener("click", () => {
  $("picker").hidden = false;
  renderPicker();
});

function addCaption(text) {
  const captions = $("captions");
  const line = document.createElement("p");
  line.textContent = text;
  captions.append(line);
  while (captions.children.length > maxCaptions) captions.firstElementChild.remove();
  $("waiting").hidden = true;
  if (mode === "listen") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

if (mode === "display") {
  $("captions").addEventListener("dblclick", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });
}

// ---------- Spoken translation ----------

const player = new Audio();
player.preload = "auto";
player.playsInline = true;
player.preservesPitch = true;
let watchdog = null;

function applyRate(rate) {
  player.defaultPlaybackRate = rate;
  player.playbackRate = rate;
}

const audio = new PlaybackQueue({
  play(base64, rate) {
    player.src = `data:audio/mpeg;base64,${base64}`;
    applyRate(rate);
    clearTimeout(watchdog);
    watchdog = setTimeout(finishClip, 30000);
    player.play().catch(finishClip);
  },
  setRate: applyRate,
});

function finishClip() {
  clearTimeout(watchdog);
  audio.finished();
}

player.addEventListener("ended", finishClip);
player.addEventListener("error", finishClip);
player.addEventListener("loadedmetadata", () => {
  if (!Number.isFinite(player.duration)) return;
  clearTimeout(watchdog);
  watchdog = setTimeout(finishClip, (player.duration / audio.rate) * 1000 + 3000);
});

function clearAudio() {
  clearTimeout(watchdog);
  if (audio.playing) player.pause();
  audio.clear();
}

function silentWavUrl() {
  const samples = 800;
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const write = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([view], { type: "audio/wav" }));
}

$("audio")?.addEventListener("click", async () => {
  audio.enabled = !audio.enabled;
  $("audio").setAttribute("aria-pressed", String(audio.enabled));
  $("audio").textContent = audio.enabled ? "🔇 Stop audio (captions only)" : "🔊 Tap to hear translation";
  if (audio.enabled) {
    // Phones only allow sound after a tap; playing silence here unlocks the player.
    player.src = silentWavUrl();
    await player.play().catch(() => {});
  } else {
    clearAudio();
  }
  sendSelection();
});

connect();
