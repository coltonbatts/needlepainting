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
pnpm install
pnpm tauri dev
```

Other scripts:

```bash
pnpm test              # Vitest
pnpm build             # Web build (tsc + vite)
pnpm tauri:build       # Desktop release + installers (see below)
```

## Packaging on macOS (signed / notarized)

The project is set up for a normal **Developer ID** distribution: bundle id `com.coltonbatts.magpie`, Hardened Runtime, and `src-tauri/entitlements.plist` (WebView-friendly; not App Sandbox — appropriate for direct download while the app uses broad file access).

1. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list), create a **Developer ID Application** certificate, install it in your login keychain (double-click the `.cer`).
2. Note the signing identity:
   ```bash
   security find-identity -v -p codesigning
   ```
3. Release build (from repo root, on a Mac):
   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
   pnpm tauri:build
   ```
   Artifacts land under `src-tauri/target/release/bundle/macos/` (`.app`) and `src-tauri/target/release/bundle/dmg/` (`.dmg`).

4. **Notarization** (so Gatekeeper is happy for users who download the DMG): set the environment variables described in [Tauri — macOS code signing](https://v2.tauri.app/distribute/sign/macos/) (App Store Connect API key **or** Apple ID + app-specific password). Re-run `pnpm tauri:build`; Tauri submits the bundle and can staple the ticket.

For **Mac App Store**, you would use different certificates, likely enable App Sandbox, and adjust entitlements — that is a separate path from Developer ID + DMG.

### Universal binary (optional)

Intel + Apple Silicon in one app:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm exec tauri build --target universal-apple-darwin
```

## Recommended IDE setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Repository

Source: [github.com/coltonbatts/needlepainting](https://github.com/coltonbatts/needlepainting)
