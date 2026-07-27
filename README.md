# Hue da Map

Fixes 3MF colors so they actually show up, and maps them onto the four **Snapmaker U1** filament slots. Drop an OpenSCAD (`basematerials`/`colorgroup`) or Bambu Studio project, remap its colors to slots, preview in 3D, and export a ready-to-slice `.3mf`.

Models often use **more than four colors**, but the U1 has only four filament slots. Hue da Map gives you an **interactive mapping matrix** to assign every input color to one of the four slots — collapsing, say, six or ten colors down to four — with a live 3D preview of exactly how the result will print.

## 🔒 100% in your browser — nothing is uploaded

Your models **never leave your machine.** Every step — reading the `.3mf`, the 3D preview, color remapping, and writing the new file — runs entirely in your browser with client-side JavaScript. There is no backend, no API, no telemetry. Even when you host it (Docker/static server), the server only sends the page to you; it never receives your files. You can confirm this by running it fully offline.

## Run it

Pick whichever is easiest for you — they all produce the same tool.

### 1. Open a single file (easiest, zero setup)

Grab `dist/index.html` — one self-contained file with everything inlined (app, 3D engine, templates) — and **open it in your browser**. No install, no server, works offline. Great for sharing: email it, drop it on a USB stick, done.

Build it yourself with [pnpm](https://pnpm.io):

```sh
pnpm install
pnpm build        # → dist/index.html
```

### 2. Serve it locally

Any static file server works:

```sh
pnpm serve        # python3 http server on http://localhost:8080
```

### 3. Self-host with Docker

```sh
docker compose up -d --build   # → http://localhost:8080
```

Static nginx image, no build step, no runtime dependencies.

### 4. Command line (batch / headless)

For scripting or bulk conversion, a Node CLI wraps the same conversion pipeline (also fully local):

```sh
pnpm convert in.3mf -o -t u1          # → in-HdM.3mf, Snapmaker U1 profile
pnpm convert *.3mf -o                 # batch: derive <name>-HdM.3mf for each
node bin/convert.mjs --help           # all options
```

## Requirements

- **Browser:** a recent Chrome, Edge, Firefox, or Safari (needs the Compression Streams API).
- **CLI / building:** Node.js ≥ 18.

## License

MIT
