# Hue da Map

## Introduction

Hue da Map is a tool to clean up files from OpenSCAD, MakerWorld, and other tools. Adds a Snapmaker U1 profile if you like. Runs entirely in the browser.

- ✅ reduce number of filament colors in 3mf files
- ✅ remap colors from one index to another
- ✅ preview the file with the mapping!
- ✅ works on multiple files! map them one at a time or give them all the same treatment

This project was created to fix colored output from OpenSCAD 3mf exports. I was generating [Gridfinity](https://www.youtube.com/watch?v=ra_9zU-mnl8) boxes with [gridfinity_extended_openscad](https://github.com/ostat/gridfinity_extended_openscad). The OpenSCAD document had color. The 3mf export did not. It turns out color painting works a little differently in slicers than in the actual 3mf spec. Huh? (Phineas as narrator: I know what we're going to do today!)

## Overview

Fixes 3MF colors so they actually show up, and maps them onto the four **Snapmaker U1** filament slots. Drop an OpenSCAD (`basematerials`/`colorgroup`) or Bambu Studio project, remap its colors to slots, preview in 3D, and export a ready-to-slice `.3mf`.

Models often use **more than four colors**, but the U1 has only four filament slots. Hue da Map gives you an **interactive mapping matrix** to assign every input color to one of the four slots — collapsing, say, six or ten colors down to four — with a live 3D preview of exactly how the result will print.

## 🔒 100% in your browser — nothing is uploaded

Your models **never leave your machine.** Every step — reading the `.3mf`, the 3D preview, color remapping, and writing the new file — runs entirely in your browser with client-side JavaScript. There is no backend, no API, no telemetry. Even when you host it (Docker/static server), the server only sends the page to you; it never receives your files. You can confirm this by running it fully offline.

## Support

If you find this useful, you can show support at [BuyMeACoffee](https://buymeacoffee.com/birnam)!

## Inspiration

I have been using [bl2u1](https://github.com/josuanbn/bl2u1) to clean up most of the files I download from MakerWorld. Except...

- ❌ it doesn't work on multiple files
- ❌ it uploads files to a server (automatically deleted after 8 hours)
- ❌ interface only lets you choose which filaments to include, which means dropping some! maybe!
- ❌ no visual aid

You can selfhost **bl2u1** (and I do), so uploading to a server isn't a problem if you have the resources. But there was room for improvement, and I felt my goals differed enough to be a new project entirely. But the **bl2u1** developer certainly deserves a coffee! So if you can, please [show some appreciation](https://buymeacoffee.com/josuanbn)!

## Was this vibe coded?

Well sure. I'm a software engineer, so I know when and how to use tools effectively. AI is great at coding, and it helps me go from idea to release quickly.

## Run it

Pick whichever is easiest for you — they all produce the same tool.

### 1. Online at https://birnam.github.io/hue-da-map/

Remember, it's all in the browser. No files get uploaded.

### 2. Open a single file (easiest, zero setup)

Download the latest `index.html` file from the [releases](https://github.com/birnam/hue-da-map/releases). It's all there. Just double click and open it in a brower. You can even do it offline!

If you clone or fork the repo, build it yourself with [pnpm](https://pnpm.io):

```sh
pnpm install
pnpm build        # → dist/index.html
```

### 3. Serve it locally

Any static file server works but if you have python3 in your path just run:

```sh
pnpm serve        # python3 http server on http://localhost:8080
```

### 4. Self-host with Docker

```sh
docker compose up -d --build   # → http://localhost:8080
```

Static nginx image, no build step, no runtime dependencies.

### 5. Command line (batch / headless)

For scripting or bulk conversion, a Node CLI wraps the same conversion pipeline (also fully local):

```sh
pnpm convert in.3mf -t u1             # → ./in-HdM.3mf, Snapmaker U1 profile
pnpm convert *.3mf                    # batch: derive <name>-HdM.3mf for each
pnpm convert in.3mf out.3mf           # explicit output name (or -o out.3mf)
pnpm convert in.3mf -o dist/          # → dist/in-HdM.3mf
pnpm convert in.3mf -o > piped.3mf    # bare -o streams to stdout
node bin/convert.mjs --help           # all options
```

## Requirements

- **Browser:** a recent Chrome, Edge, Firefox, or Safari (needs the Compression Streams API).
- **CLI / building:** Node.js ≥ 18.

## License

MIT
