# J.A.R.V.I.S.

A browser voice assistant with an Iron Man holographic interface. Say
**"Hey Jarvis"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

**The only subscription you need is Claude Code.** No API keys, no OpenAI
account, no cloud bill — the brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

---

## Requirements

**In one line:** a Claude Code subscription, plus two free things every computer
can have — Node.js and Chrome. That's the whole list.

- **A Claude Code login on this computer** — this is the only account you need.
  The Agent SDK ships its own copy of the `claude` binary, so JARVIS does not run
  your installed CLI; what it needs is the *login*. Install Claude Code once —
  `npm install -g @anthropic-ai/claude-code`, or the platform installer at
  <https://docs.claude.com/en/docs/claude-code> — run `claude`, and complete
  login. That leaves the credentials in `~/.claude` (`%USERPROFILE%\.claude` on
  Windows), which the bridge reuses: **no API key**, billed to your existing
  Claude account. See [Signing in to Claude](#signing-in-to-claude) for the
  alternatives.
- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click **INITIALISE**, and say **“Hey Jarvis”**.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and say **"Hey Jarvis"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## Signing in to Claude

The bridge's Claude brain runs through the Agent SDK, which bundles the
`claude` binary — so the Claude Code CLI does not have to be on the `PATH`, and
the installed desktop app works on a machine without Node. It does need to be
signed in, in one of these ways:

| How | What to do | Billed to |
|---|---|---|
| **Claude Code login** (default) | Install Claude Code once, run `claude`, log in. Credentials land in `~/.claude`, where the bridge finds them. | Your Claude subscription |
| **Long-lived token** | Run `claude setup-token` on any machine, put `CLAUDE_CODE_OAUTH_TOKEN=...` in `.env.local` (installed app: `%APPDATA%\JARVIS\.env.local`). No CLI needed on the machine running JARVIS. | Your Claude subscription |
| **API key** | Put `ANTHROPIC_API_KEY=...` in that same `.env.local`. | Anthropic API usage |

With none of these, the Claude brain cannot answer — but the
[local brain (Ollama)](#local-brain-ollama) needs no account at all.

The MCP servers JARVIS can use are read from `~/.claude.json`, the same file
Claude Code keeps its configuration in. On a machine where Claude Code was
never set up, he still has his built-in tools (HUD, interface, briefing, home)
but none of yours.

---

## Desktop app (Windows)

The same interface as a desktop window, with a real embedded browser (signed-in
sites, scripts and all) that the web build cannot have.

```bash
npm run app          # from the source tree: starts bridge + Vite + window
npm run app:writes   # same, with effectful tools allowed (see below)
```

### Building the installer

```bash
npm run dist
```

Writes `release/JARVIS-Setup-<version>.exe`. The installer carries **no keys**:
on first build, this machine's `.env.local` and `preferencias.md` are copied to
`%APPDATA%\JARVIS`, which is where the installed app reads them. On another
machine, put a `.env.local` there by hand. The bridge's output goes to
`%APPDATA%\JARVIS\jarvis.log`.

### Installing

The installer asks three things, after the install folder:

- **your name** — shown on the HUD and used in the welcome;
- **senhor / senhora** — how he addresses you;
- **the voice** — Piper (local, Brazilian Portuguese, the default), the Windows
  voice, or Kokoro (British English, slow).

The answers go to `%APPDATA%\JARVIS\jarvis.ini` and are read on every launch,
so they override the `VITE_USER_NAME`, `VITE_USER_TITLE` and `VITE_TTS_ENGINE`
compiled into the build. Change them by editing that file (then restart
JARVIS) or by running the installer again, which shows them filled in.
Automatic updates skip the question and leave the file alone.

```ini
[interface]
user_name=Jonathan Rodrigues
user_title=senhor
tts_engine=piper
```

### Running in the background

Installed, JARVIS lives in the **system tray**:

- Closing the window only hides it — he keeps listening for the wake word and
  answering.
- Click the tray icon to bring the window back; right-click for **Abrir** and
  **Sair**. Quitting is the tray's job.
- Launching it again just brings back the running instance.

### Updates

Installed copies update themselves from this repository's GitHub releases. On
each launch the app checks for a newer version and, if there is one, asks:
**Atualizar agora** downloads it (progress shows on the taskbar icon), closes
JARVIS, shows the installer's progress window and starts the new version; **Depois** asks again next launch. Settings in
`%APPDATA%\JARVIS` are never touched by an update.

To ship a version, push a tag:

```bash
git tag v1.2.0
git push origin v1.2.0
```

The `release` workflow (`.github/workflows/release.yml`) builds the installer
on a Windows runner — downloading Piper, since it is not in git — and publishes
it as a GitHub release. The version comes from the tag; `package.json` never
needs bumping. Nothing personal is compiled in — the name and the voice come
from the installer — so the workflow needs no secrets or variables.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey Jarvis" wake word            │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The model.** `claude-opus-5` at effort `high` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort medium`.

### The voice pipeline

The loop is designed so that nothing silently dies and barge-in feels natural.

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot quietly
  fail, and is what makes **barge-in** work — speak while JARVIS is talking and he
  stops.
- **Transcription has two tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → ElevenLabs Scribe, via the bridge `/stt` endpoint.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    guarded by a heartbeat so it recovers when Chrome throttles it.
- **Speaking** uses the **ElevenLabs voice when a key is present**, and the
  browser's `speechSynthesis` otherwise. If a cloud call fails it falls back to
  the browser voice, and if the OS voice itself is broken it latches over to the
  cloud voice.

- **Piper** (`VITE_TTS_ENGINE=piper`) is a local neural voice the bridge runs
  natively — fast, offline, Brazilian Portuguese. It outranks the automatic
  ElevenLabs voice. Install it into `piper/` (gitignored):

  ```sh
  mkdir -p piper/voices && cd piper
  curl -LO https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip
  unzip piper_windows_amd64.zip && rm piper_windows_amd64.zip
  cd voices
  for f in pt_BR-faber-medium.onnx pt_BR-faber-medium.onnx.json; do
    curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/pt/pt_BR/faber/medium/$f
  done
  ```

  Other voices drop into `piper/voices/` and are picked with `JARVIS_PIPER_VOICE`.

So it works with no keys and auto-upgrades when a key appears — there is no flag
to set. Capability detection lives in `src/lib/capabilities.ts`, which probes the
bridge's `GET /health` (returning `{ ok, tts, stt }`, both tracking the
ElevenLabs key) once at boot and picks the engines.

---

### Local brain (Ollama)

Claude is the default brain. A local model on [Ollama](https://ollama.com) can
take over with **M** on the HUD (the conversation restarts, since each brain has
its own session). Ollama serves the Anthropic Messages API, so it runs through
the same Agent SDK session — tools, streaming and the permission gate are
unchanged. See `bridge/ollama.mjs`.

```sh
ollama pull qwen3:4b-instruct
ollama create jarvis-qwen3:4b -f bridge/ollama/Modelfile   # 8k context
```

By default the local brain runs lean: a short Portuguese persona, the briefing,
home and camera tools only, and thinking forced off. On "bom dia" the bridge
hands it the weather and headlines and puts the cards up itself. A 4B model
that fits entirely in a 6GB GPU answers in well under a second this way;
`JARVIS_OLLAMA_TOOLS=all` gives it the full toolset at a large cost in speed.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly. Depending
on what you have installed, that is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

> **Note on account connectors.** Servers you added through your **claude.ai
> account** are not stored on disk, so the bridge cannot see them — it works from
> the servers in `~/.claude.json` (about 14), not the claude.ai ones.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him |
| **Space** | Talk without the wake word |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **V** | Cycle the browser voice |
| **Escape** | Stand down |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |

---

## The boot sequence

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "J.A.R.V.I.S"; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Configuration

Everything is optional in bridge mode. Frontend settings live in `.env.local`
(copy `.env.example`); bridge settings are environment variables.

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_MODEL` | `claude-opus-5` | Model to run |
| `JARVIS_EFFORT` | `high` | Reasoning effort |
| `JARVIS_ALLOW_WRITES` | off | `1` allows effectful tools (see below) |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_FILE_ROOTS` | — | Roots the `/file` endpoint may serve from |
| `JARVIS_VOICE_ID` | — | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | — | Optional; enables the ElevenLabs voice + Scribe |

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge |
| `VITE_TTS_ENGINE` | `system`, `kokoro` or `piper` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only |

### Adding an ElevenLabs key

You do not have to touch a flag. Either:

- Set `ELEVENLABS_API_KEY` on the bridge before starting it, **or**
- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json` — the
  bridge reads it from there too.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically.

---

## Enabling actions

The tool gate starts **read-only**. Search, generation and lookups run freely;
anything effectful — send, tap, delete, install, pay — is denied. Voice is a poor
interface for a confirmation dialog, so the decision is made ahead of time in
`decideTool()` in `bridge/server.mjs`, not at the moment of use. The bridge sets
`settingSources: []`, which makes its own gate the only authority — filesystem
settings and any global `bypassPermissions` cannot override it.

To allow effectful tools (phone, browser driving, sending), run the bridge this
way instead:

```bash
npm run bridge:writes
```

> Read `decideTool()` before you do. *"Hey Jarvis, clean up my downloads folder"*
> means something rather different with writes enabled.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`.

---

## Security

All of this lives in `bridge/server.mjs`:

- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`decideTool`) is default-deny for effectful MCP tools.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
