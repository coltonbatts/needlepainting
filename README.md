# Magpie

Desktop app that turns photos into **cross-stitch / needlepainting-style patterns**: outlined regions, **DMC thread** colors, and an interactive grid you can zoom and inspect.

Built with **Tauri 2**, **React**, **TypeScript**, and **Vite**, with image processing in **Rust**.

## Features

- **Load an image** and generate a quantized pattern with configurable color count, grid size, and line thickness.
- **Live preview** with outline and thread-color modes, optional grid and DMC number labels.
- **Thread isolation**: select a palette swatch to highlight only that thread. The **full page outline** stays visible so you can see where that color sits relative to the rest of the pattern (like an empty coloring book with one shade filled in).
- **PNG export** (line art, thread + outline, or thread fill) with an optional legend.
- **Processing progress** events from the backend for long-running jobs.

## Development

Prerequisites: [Rust](https://www.rust-lang.org/tools/install), [Node.js](https://nodejs.org/) (20.19+ or 22.12+ recommended for Vite 7), and platform packages for Tauri as in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev
```

Other scripts:

```bash
npm test          # Vitest
npm run build     # Web build (tsc + vite)
npm run tauri build   # Desktop production build
```

## Recommended IDE setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Repository

Source: [github.com/coltonbatts/needlepainting](https://github.com/coltonbatts/needlepainting)
