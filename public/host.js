import { INPUT_LANGUAGES, OUTPUT_LANGUAGES, TTS_VOICES, RTL_LANGUAGES, languageName } from "./languages.js";

const $ = (id) => document.getElementById(id);
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};
const MAX_TRANSCRIPT_ENTRIES = 200;

let settings = null;
let socket = null;
let running = false;
let capture = null;
let listenerBaseUrl = `${location.origin}/`;

// ---------- Settings ----------

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
  return response.json();
}

async function saveSettings(patch) {
  try {
    settings = await api("/api/settings", patch);
    renderScreenBuilder();
  } catch (error) {
    showNotice(`Could not save settings: ${error.message}`, "error");
  }
}

function renderSettings() {
  $("input-language").value = settings.inputLanguage;
  $("voice").value = settings.voice;
  $("translation-model").value = settings.translationModel;
  $("speech-model").value = settings.speechModel;
  $("transcription-model").value = settings.transcriptionModel;
  for (const box of $("output-languages").querySelectorAll("input")) {
    box.checked = settings.outputLanguages.includes(box.value);
  }
  const hasKeys = settings.hasOpenaiKey && settings.hasDeepgramKey;
  $("keys-saved").hidden = !hasKeys;
  $("keys-form").hidden = hasKeys;
  $("keys-cancel").hidden = !hasKeys;
  renderScreenBuilder();
}

function buildControls() {
  $("input-language").replaceChildren(...INPUT_LANGUAGES.map((code) =>
    new Option(`${languageName(code)} (${code})`, code)));
  $("voice").replaceChildren(...TTS_VOICES.map(({ value, label }) => new Option(label, value)));
  const sorted = [...OUTPUT_LANGUAGES].sort((a, b) => languageName(a).localeCompare(languageName(b)));
  $("output-languages").replaceChildren(...sorted.map((code) => {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = code;
    label.dataset.search = `${languageName(code)} ${languageName(code, code)} ${code}`.toLowerCase();
    label.append(box, languageName(code));
    return label;
  }));

  $("input-language").addEventListener("change", (event) => saveSettings({ inputLanguage: event.target.value }));
  $("voice").addEventListener("change", (event) => saveSettings({ voice: event.target.value }));
  $("output-languages").addEventListener("change", () => {
    const selected = [...$("output-languages").querySelectorAll("input:checked")].map((box) => box.value);
    saveSettings({ outputLanguages: selected });
  });
  $("language-filter").addEventListener("input", (event) => {
    const query = event.target.value.trim().toLowerCase();
    for (const label of $("output-languages").children) label.hidden = !label.dataset.search.includes(query);
  });
  for (const [id, name] of [["translation-model", "translationModel"], ["speech-model", "speechModel"], ["transcription-model", "transcriptionModel"]]) {
    $(id).addEventListener("change", async (event) => {
      await saveSettings({ [name]: event.target.value });
      renderSettings();
    });
  }

  $("keys-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const patch = {};
    if ($("openai-key").value.trim()) patch.openaiKey = $("openai-key").value;
    if ($("deepgram-key").value.trim()) patch.deepgramKey = $("deepgram-key").value;
    if (!Object.keys(patch).length && !settings.hasOpenaiKey && !settings.hasDeepgramKey) {
      $("keys-result").textContent = "Paste both keys first.";
      return;
    }
    $("keys-result").textContent = "Checking keys…";
    await saveSettings(patch);
    $("openai-key").value = "";
    $("deepgram-key").value = "";
    const result = await api("/api/verify-keys", {}).catch((error) => ({ error }));
    const lines = [];
    if (result.error) lines.push(`Could not check keys: ${result.error.message}`);
    if (!settings.hasOpenaiKey) lines.push("OpenAI key missing.");
    else if (result.openai && !result.openai.ok) lines.push(`OpenAI: ${result.openai.message}`);
    if (!settings.hasDeepgramKey) lines.push("Deepgram key missing.");
    else if (result.deepgram && !result.deepgram.ok) lines.push(`Deepgram: ${result.deepgram.message}`);
    $("keys-result").textContent = lines.join(" ") || "Both keys work.";
    if (lines.length) {
      $("keys-form").hidden = false;
      $("keys-saved").hidden = true;
    } else {
      renderSettings();
    }
  });
  $("keys-edit").addEventListener("click", () => {
    $("keys-form").hidden = false;
    $("keys-saved").hidden = true;
    $("keys-result").textContent = "Leave a field blank to keep its saved key.";
    $("openai-key").focus();
  });
  $("keys-cancel").addEventListener("click", renderSettings);
}

// ---------- Microphone ----------

async function listMicrophones() {
  const select = $("microphone");
  const saved = storage.get("microphone") || "";
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
  select.replaceChildren(new Option("Default microphone", ""), ...devices
    .filter((device) => device.deviceId && device.deviceId !== "default")
    .map((device, index) => new Option(device.label || `Input ${index + 1}`, device.deviceId)));
  select.value = [...select.options].some((option) => option.value === saved) ? saved : "";
}

async function startCapture() {
  if (capture) return capture;
  const deviceId = $("microphone").value;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId && { deviceId: { exact: deviceId } }),
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule("/assets/pcm-worklet.js");
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "pcm-capture");
  node.port.onmessage = ({ data }) => {
    $("meter-fill").style.width = `${Math.min(100, Math.round(data.level * 400))}%`;
    if (running && socket?.readyState === WebSocket.OPEN) socket.send(data.pcm);
  };
  source.connect(node);
  capture = { stream, context };
  $("mic-test").textContent = "Stop microphone test";
  listMicrophones().catch(() => {});
  return capture;
}

function stopCapture() {
  if (!capture) return;
  capture.stream.getTracks().forEach((track) => track.stop());
  capture.context.close();
  capture = null;
  $("meter-fill").style.width = "0";
  $("mic-test").textContent = "Test microphone";
}

$("mic-test").addEventListener("click", async () => {
  if (capture && !running) return stopCapture();
  try {
    await startCapture();
  } catch (error) {
    showNotice(`Microphone unavailable: ${error.message}`, "error");
  }
});

$("microphone").addEventListener("change", async () => {
  storage.set("microphone", $("microphone").value);
  if (!capture) return;
  stopCapture();
  try {
    await startCapture();
  } catch (error) {
    showNotice(`Microphone unavailable: ${error.message}`, "error");
  }
});

// ---------- Broadcast ----------

$("start").addEventListener("click", async () => {
  if (running) {
    socket?.send(JSON.stringify({ type: "stop" }));
    return;
  }
  try {
    await startCapture();
  } catch (error) {
    return showNotice(`Microphone unavailable: ${error.message}`, "error");
  }
  hideNotice();
  socket?.send(JSON.stringify({ type: "start" }));
});

function setRunning(value) {
  running = value;
  $("start").textContent = running ? "Stop broadcast" : "Start broadcast";
  $("start").className = running ? "danger big" : "primary big";
  $("status").textContent = running ? "Live" : socket?.readyState === WebSocket.OPEN ? "Ready" : "Offline";
  $("status").className = running ? "pill live" : "pill";
  if (!running) {
    stopCapture();
    $("interim").textContent = "";
  }
}

function connect() {
  socket = new WebSocket(`ws://${location.host}/ws/host`);
  socket.binaryType = "arraybuffer";
  socket.onopen = () => setRunning(running);
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "state") {
      if (message.running && !running) $("transcript").replaceChildren();
      setRunning(message.running);
    } else if (message.type === "notice") {
      showNotice(message.message, message.level);
    } else if (message.type === "listeners") {
      renderListeners(message);
    } else if (message.type === "transcript") {
      if (message.final) addTranscript(message);
      else $("interim").textContent = message.text;
    } else if (message.type === "caption") {
      addTranslation(message);
    }
  };
  socket.onclose = () => {
    setRunning(false);
    setTimeout(connect, 1000);
  };
}

function renderListeners({ total, byLanguage }) {
  const parts = Object.entries(byLanguage).map(([code, { listeners, audio }]) =>
    `${languageName(code)} ${listeners}${audio ? ` (${audio} listening)` : ""}`);
  $("listener-summary").textContent = total
    ? `${total} connected${parts.length ? ` · ${parts.join(" · ")}` : ""}`
    : "No listeners connected";
}

function addTranscript({ seq, text }) {
  const entry = document.createElement("div");
  entry.className = "entry";
  entry.dataset.seq = seq;
  const original = document.createElement("p");
  original.className = "original";
  original.textContent = text;
  entry.append(original);
  const transcript = $("transcript");
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  transcript.append(entry);
  while (transcript.children.length > MAX_TRANSCRIPT_ENTRIES) transcript.firstElementChild.remove();
  $("interim").textContent = "";
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;
}

function addTranslation({ seq, language, text }) {
  const entry = $("transcript").querySelector(`[data-seq="${seq}"]`);
  if (!entry) return;
  const line = document.createElement("p");
  line.className = "translation";
  line.dir = RTL_LANGUAGES.has(language.split("-")[0]) ? "rtl" : "auto";
  const tag = document.createElement("b");
  tag.textContent = language;
  line.append(tag, text);
  entry.append(line);
}

// ---------- Sharing ----------

async function loadShareLinks() {
  const { links } = await api("/api/share");
  $("no-network").hidden = links.length > 0;
  $("share").hidden = links.length === 0;
  if (!links.length) return;
  const [primary, ...others] = links;
  listenerBaseUrl = primary.url;
  updateScreenLink();
  $("qr").innerHTML = primary.qrSvg;
  $("share-url").textContent = primary.url;
  $("share-url").href = primary.url;
  $("display-url").href = primary.displayUrl;
  $("other-links").replaceChildren(...others.map(({ name, url }) => {
    const item = document.createElement("li");
    item.textContent = `${name}: ${url}`;
    return item;
  }));
}

async function copyText(button, text) {
  const label = button.textContent;
  await navigator.clipboard.writeText(text);
  button.textContent = "Copied";
  setTimeout(() => { button.textContent = label; }, 1500);
}

$("copy-url").addEventListener("click", (event) => copyText(event.target, $("share-url").href));

// ---------- Screen captions / embed ----------

function renderScreenBuilder() {
  const select = $("screen-language");
  const current = select.value;
  select.replaceChildren(new Option("First language", ""),
    ...settings.outputLanguages.map((code) => new Option(languageName(code), code)));
  select.value = settings.outputLanguages.includes(current) ? current : "";
  updateScreenLink();
}

function screenLink() {
  const url = new URL("display", listenerBaseUrl);
  if ($("screen-language").value) url.searchParams.set("language", $("screen-language").value);
  if ($("screen-theme").value !== "dark") url.searchParams.set("theme", $("screen-theme").value);
  if ($("screen-size").value) url.searchParams.set("fontSize", $("screen-size").value);
  url.searchParams.set("lines", $("screen-lines").value);
  return url.href;
}

function updateScreenLink() {
  $("screen-url").value = screenLink();
  $("open-screen-url").href = screenLink();
}

for (const id of ["screen-language", "screen-theme", "screen-size", "screen-lines"]) {
  $(id).addEventListener("change", updateScreenLink);
}
$("copy-screen-url").addEventListener("click", (event) => copyText(event.target, screenLink()));
$("copy-screen-iframe").addEventListener("click", (event) => {
  const src = screenLink().replaceAll("&", "&amp;");
  copyText(event.target, `<iframe src="${src}" title="Live translation captions" width="100%" height="360" style="border:0;background:transparent" allow="fullscreen"></iframe>`);
});

// ---------- Notices ----------

function showNotice(text, level = "warning") {
  $("notice-text").textContent = text;
  $("notice").className = `notice ${level}`;
  $("notice").hidden = false;
}
function hideNotice() {
  $("notice").hidden = true;
}
$("notice-close").addEventListener("click", hideNotice);

// ---------- Updates ----------
// Release notes come from GitHub, so they are rendered as plain text only.

function plainText(markdown) {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .trim();
}

function renderReleaseNotes(release) {
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  heading.textContent = release.name === release.version || release.name === `v${release.version}`
    ? `Version ${release.version}`
    : `${release.name} (${release.version})`;
  section.append(heading);
  let list = null;
  // Anything after a "---" line is meant for the GitHub page, not the app.
  for (const line of release.notes.split(/^-{3,}\s*$/m)[0].split(/\r?\n/)) {
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const text = plainText(bullet ? bullet[1] : line.replace(/^#+\s*/, ""));
    if (!text || /^(what's new|full changelog)/i.test(text)) continue;
    if (bullet) {
      list ??= section.appendChild(document.createElement("ul"));
      list.appendChild(document.createElement("li")).textContent = text;
    } else {
      list = null;
      section.appendChild(document.createElement("p")).textContent = text;
    }
  }
  if (!release.notes.trim()) section.appendChild(document.createElement("p")).textContent = "No notes for this release.";
  return section;
}

async function checkForUpdate() {
  const update = await api("/api/update");
  if (!update.available || storage.get("dismissedUpdate") === update.latest) return;
  $("update-title").textContent = `Speak To All ${update.latest} is available.`;
  $("update-current").textContent = `You have ${update.current}.`;
  $("update-download").href = update.url;
  $("update-notes").replaceChildren(...update.releases.map(renderReleaseNotes));
  $("update").hidden = false;
  $("update-dismiss").onclick = () => {
    storage.set("dismissedUpdate", update.latest);
    $("update").hidden = true;
  };
}

// ---------- Boot ----------

buildControls();
settings = await api("/api/settings");
renderSettings();
listMicrophones().catch(() => {});
navigator.mediaDevices.addEventListener("devicechange", () => listMicrophones().catch(() => {}));
loadShareLinks().catch((error) => showNotice(`Could not find network address: ${error.message}`));
// WiFi can change mid-session (laptop roams, DHCP renews).
setInterval(() => loadShareLinks().catch(() => {}), 15000);
connect();
checkForUpdate().catch(() => {});
