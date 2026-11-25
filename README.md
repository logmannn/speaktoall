# Speak To All

Free, open-source live translation for churches, meetings, and events. It runs
entirely on your own computer with your own API keys: no accounts, no
subscription, and no middleman server.

The speaker talks into a microphone on the broadcasting computer. People on the
same WiFi scan a QR code with their phone and read or hear the translation in
their language. A projector page shows large captions.

```
microphone ─► this computer ──► Deepgram (speech to text)
                    │      └──► OpenAI (translation, optional speech)
                    └── local WiFi ──► phones and projector
```

## Install

Download the installer for your computer from the
[latest release](../../releases/latest):

| Computer | File |
| --- | --- |
| Mac with Apple chip (M1 or newer) | `SpeakToAll-…-mac-arm64.dmg` |
| Mac with Intel chip | `SpeakToAll-…-mac-x64.dmg` |
| Windows | `SpeakToAll-…-win-x64.exe` |
| Linux | `SpeakToAll-…-linux-x86_64.AppImage` |

The installers are free and not signed with a paid Apple/Microsoft developer
certificate, so the first launch needs one extra step:

- **Mac:** open the `.dmg` and drag Speak To All into Applications, then open it.
  If macOS says it "could not verify" the app, open **System Settings → Privacy &
  Security**, scroll down, and click **Open Anyway**. Allow microphone access when asked.
- **Windows:** run the `.exe`. If SmartScreen appears, click **More info → Run anyway**.
  Allow access on private networks when Windows Firewall asks.
- **Linux:** make the AppImage executable (`chmod +x`) and run it.

<details>
<summary>Or run from source (needs Node.js)</summary>

1. Install [Node.js](https://nodejs.org) (LTS version).
2. Download this repository (green **Code** button → **Download ZIP**, then unzip),
   or `git clone` it.
3. Run `./start.sh` (Mac/Linux) or double-click `start.bat` (Windows). The first
   run installs dependencies, which takes a minute.

</details>

## Quick start

1. Open Speak To All.
2. Paste your API keys:
   - **OpenAI:** <https://platform.openai.com/api-keys> (add a few dollars of credit)
   - **Deepgram:** <https://console.deepgram.com/> (new accounts get free credit)
3. Pick the spoken language, the languages to translate into, and the microphone.
4. Press **Start broadcast**. Listeners scan the QR code shown in the app.

Allow incoming connections if your computer's firewall asks; phones cannot
connect otherwise.

## What it costs

You pay OpenAI and Deepgram directly at their API rates. Approximate cost
for an hour of continuous speech with default models (check the providers'
pricing pages for current rates):

| | Per hour |
| --- | ---: |
| Transcription (Deepgram Nova-3 streaming) | ~$0.30–0.50 |
| Text translation, per language | a few cents |
| Spoken translation, per language with someone listening | ~$0.50–1.00 |

To keep costs down, languages are only translated while someone has them
selected, and speech is only generated while someone has audio turned on.
The first selected language is always translated so you can see it working.

## Listener tips

- Phones must be on the **same WiFi** as the broadcasting computer. Guest
  networks that block devices from seeing each other ("client isolation") will
  not work; use the main network or a dedicated router/hotspot.
- Listeners tap **Tap to hear translation** to hear audio (phones require a tap
  before playing sound). Headphones recommended.
- For a projector or TV, open the **Projector captions** link on a computer
  connected to it. Double-click for full screen.
- Keep the broadcasting computer awake and plugged in. The app prevents it from
  suspending while open.

## Captions on screens, OBS, and ProPresenter

On the host page, open **Captions on a screen, OBS, or ProPresenter** to build
a caption link, then copy the link or the embed code. Use it as:

- **A TV or projector:** open the link in any browser on that computer and go full screen.
- **OBS livestream overlay:** add a *Browser* source with the link and choose
  **Transparent** so captions sit on top of the video.
- **ProPresenter:** add a *Web* layer with the link.
- **Your own page:** paste the embed code (`<iframe>`). It must be viewed on the
  same WiFi; it cannot go on your public website, because the captions come from this computer.

Link options:

| Option | Values | Default |
| --- | --- | --- |
| `language` | A selected language code, such as `es` | First selected language |
| `theme` | `dark`, `light`, `transparent` | `dark` |
| `fontSize` | 24–200 (pixels) | Fits the screen |
| `lines` | 1–10 | 3 |

Example: `http://192.168.1.20:4949/display?language=es&theme=transparent&fontSize=56&lines=2`

Transparent and embedded captions hide the status badge and waiting message,
so nothing shows until someone speaks. Caption screens never trigger spoken
translation.

## Privacy and security

- API keys are encrypted with your operating system's keychain and stored only
  on this computer. They are never sent to listeners.
- Audio and text go directly from this computer to Deepgram and OpenAI.
- The host controls (`/host`) only work on the broadcasting computer itself.
  Anyone on the same WiFi can open the listener page.

## Running without the desktop app

```sh
npm install
OPENAI_API_KEY=... DEEPGRAM_API_KEY=... npm run server
```

Then open <http://localhost:4949/host> in Chrome or Edge on the same computer.
Keys entered in the page are saved unencrypted (owner-only permissions) in
`~/.speaktoall-local/settings.json`. Set `PORT` to use a different port.

## Models

Defaults: Deepgram `nova-3` for transcription, OpenAI `gpt-5.6-luna` for
translation, and OpenAI `tts-1` for speech. Change them under **Models** on
the host page; any model your keys can access works.

## Development

```sh
npm install
npm start     # desktop app
npm test      # tests use fake providers and spend no API credits
npm run dist  # build an installer for this OS into dist/
```

To publish a release, bump `version` in `package.json`, then push a tag
(`git tag v0.2.0 && git push --tags`). GitHub Actions builds the Mac, Windows,
and Linux installers and attaches them to a draft release; review and publish it.

| Path | What it does |
| --- | --- |
| `electron/main.js` | Desktop shell: starts the server, opens the host page, keychain storage |
| `src/server.js` | HTTP/WebSocket server; host vs. listener access rules |
| `src/broadcast.js` | Transcript → translation → speech pipeline, ordering, cost-saving demand logic |
| `src/providers.js` | Deepgram and OpenAI clients |
| `src/store.js` | Settings file |
| `public/host.*` | Host dashboard |
| `public/listen.*`, `public/display.html` | Phone listener page and projector captions |
| `public/pcm-worklet.js` | Converts microphone audio to 16 kHz PCM |

Contributions welcome: other providers (local Whisper, other translation
models), packaged installers, more interface languages.

## License

MIT
