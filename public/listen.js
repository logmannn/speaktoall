import { RTL_LANGUAGES, languageName } from "./languages.js";

const $ = (id) => document.getElementById(id);
const mode = document.body.dataset.mode; // "listen" (phones) or "display" (projector)
const params = new URLSearchParams(location.search);
let maxCaptions = 80;
const MIN_RATE = 1;
const MAX_RATE = 1.4;

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
let audioOn = false;

// ---------- Connection ----------

function connect() {
  socket = new WebSocket(`ws://${location.host}/ws/listen`);
  socket.onopen = () => { retry = 0; };
  socket.onmessage = ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.type === "state") onState(message);
    else if (message.type === "caption" && message.language === language) addCaption(message.text);
    else if (message.type === "audio" && message.language === language && audioOn) enqueueAudio(message.audio);
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
  socket.send(JSON.stringify({ type: "select", language, audio: audioOn }));
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
// The server releases audio in speech order, so clips play first-in, first-out.
// Playback speeds up a little when clips pile up and slows down when caught up.

const player = new Audio();
player.preload = "auto";
player.playsInline = true;
player.preservesPitch = true;
let queue = [];
let playing = false;
let rate = MIN_RATE;
let watchdog = null;

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

function setRate(next) {
  rate = Math.min(MAX_RATE, Math.max(MIN_RATE, next));
  player.defaultPlaybackRate = rate;
  player.playbackRate = rate;
}

function enqueueAudio(base64) {
  queue.push(base64);
  if (queue.length >= 2) setRate(rate + 0.1);
  playNext();
}

function playNext() {
  if (playing || !audioOn || !queue.length) return;
  playing = true;
  player.src = `data:audio/mpeg;base64,${queue.shift()}`;
  setRate(rate);
  clearTimeout(watchdog);
  watchdog = setTimeout(finishClip, 30000);
  player.play().catch(finishClip);
}

function finishClip() {
  clearTimeout(watchdog);
  if (!playing) return;
  playing = false;
  if (!queue.length) setRate(rate - 0.1);
  playNext();
}

player.addEventListener("ended", finishClip);
player.addEventListener("error", finishClip);
player.addEventListener("loadedmetadata", () => {
  if (!Number.isFinite(player.duration)) return;
  clearTimeout(watchdog);
  watchdog = setTimeout(finishClip, (player.duration / rate) * 1000 + 3000);
});

function clearAudio() {
  queue = [];
  clearTimeout(watchdog);
  if (playing) player.pause();
  playing = false;
  setRate(MIN_RATE);
}

$("audio")?.addEventListener("click", async () => {
  audioOn = !audioOn;
  $("audio").setAttribute("aria-pressed", String(audioOn));
  $("audio").textContent = audioOn ? "🔇 Stop audio (captions only)" : "🔊 Tap to hear translation";
  if (audioOn) {
    // Phones only allow sound after a tap; playing silence here unlocks the player.
    player.src = silentWavUrl();
    await player.play().catch(() => {});
  } else {
    clearAudio();
  }
  sendSelection();
});

connect();
