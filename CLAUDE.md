# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single Rust + Tauri 2 app ("CMF EQ") that edits the stored 8-band parametric EQ, ANC, and
spatial-audio settings of CMF Headphone Pro (B175) headphones over the Nothing control
protocol. It builds for Windows and Android from one codebase. The frontend is
dependency-free vanilla JS (`ui/`); there is no bundler, no framework, and no npm build step
for the UI.

## Commands

Builds run through GitHub Actions (`.github/workflows/build.yml` for Windows,
`android.yml` for Android). Do not install local C++ build tools.

```powershell
cargo build --release --features desktop --locked   # Windows app -> target/release/cmf-eq.exe
npm ci --ignore-scripts                              # only for the Tauri CLI launcher
npx --no-install tauri icon ui/brand-mark.svg --output icons/android
npx --no-install tauri android init --ci --skip-targets-install
npx --no-install tauri android build --debug --apk --target aarch64 --features app --ci
```

The `desktop`/`app` feature gates everything UI-facing. Without it only `autoeq` and `protocol`
compile, so a plain `cargo check` exercises the protocol layer alone.

Do not run automated tests locally or in CI unless the user explicitly changes that instruction.
There are seven unit tests (`src/protocol.rs`, `src/autoeq.rs`); if testing is requested, the
relevant command is `cargo test --lib` *without* `--features app`, which is the configuration in
which they compile.

### UI without hardware

`ui/app.mjs` falls back to mocks when `window.__TAURI__?.core?.invoke` is absent. Open
`ui/index.html?preview=connected` in a browser for a populated connected-device view, or with no
query string for the disconnected state. This is the normal way to iterate on layout and the
response graph.

### The `tools/` scripts

`gen/` is gitignored and Tauri regenerates it from scratch, so the checked-in Kotlin transport has
to be installed into the generated project after every `tauri android init`. Two Python scripts do
that, and both are runtime/build dependencies of `android.yml`, not optional extras:

- `tools/prepare_android.py` — the critical one. Copies `android/BluetoothPlugin.kt` to
  `gen/android/app/src/main/java/app/cmfeq/bluetooth/` (matching the `register_android_plugin`
  path in `android_transport.rs`) and `android/cmf_mark.xml` to `res/drawable/`, then patches
  `AndroidManifest.xml` with `BLUETOOTH_CONNECT` plus legacy `BLUETOOTH`/`BLUETOOTH_ADMIN`
  (`maxSdkVersion=30`), `allowBackup=false`, and portrait orientation. Without it the plugin fails
  to register and the permission request is denied at runtime.
- `tools/report_android_failure.py` — cosmetic; reformats the tail of the build logs into bounded
  GitHub annotations so a failure is readable in the public CI log.

Both depend only on the standard library. If you add a new manifest permission or change the
plugin's package, update `prepare_android.py` in the same change.

## Architecture

### Layering

`src/lib.rs` defines the split, and it is deliberate:

- `autoeq.rs` — Equalizer APO text parser, `Profile`/`Filter` types, and `validate()`. Every
  other layer calls `validate()` before doing anything with a profile. Limits: 1–8 active
  filters, frequency 20–20000 Hz, Q > 0, finite f32s, unique positive IDs.
- `protocol.rs` — pure bytes. Packet framing (magic `0x55`, control `0x0660`, CRC-16/ARC), a
  streaming `Decoder` that tolerates fragmented and interleaved frames, and
  `encode_eq`/`decode_eq` for the 13-byte-per-filter device layout. **No socket code here**,
  which is why the protocol stays testable offline.
- `bluetooth.rs` — the `Controller`: session state, request/response sequencing, all setting
  reads and writes, and `ConnectionStatus` (the single struct the UI renders).
- `snapshots.rs` — immutable per-device/per-firmware EQ backups and the gain-undo record.
- `profile_library.rs` — named local profiles, validated and lock-protected.
- `app.rs` — Tauri commands. Thin by design: each one clones the `Arc<Mutex<…>>` state handle and
  delegates to `Controller`/`ProfileLibrary` inside `spawn_blocking`, because all Bluetooth I/O
  is blocking. Mutexes are never held across an await.

### Transport seam

`bluetooth.rs` declares `mod platform` three times, selected by `cfg`:

- `cfg(windows)` — raw Win32 FFI: `bthprops` for paired-device enumeration, `ws2_32` for
  RFCOMM (`AF_BTH`, service UUID `AEAC4A03-DFF5-498F-843A-34487CF133EB`). Structures follow
  `bluetoothapis.h`; `SOCKADDR_BTH` is packed at 30 bytes.
- `cfg(target_os = "android")` — aliases `crate::android_transport` as `platform`.
- otherwise — stubs that return errors.

`android_transport.rs` implements the same `Socket` surface (`connect`/`send_all`/`receive`) by
bridging to the Kotlin plugin in `android/BluetoothPlugin.kt`, which owns only RFCOMM bytes and
the `BLUETOOTH_CONNECT` permission. Protocol framing and every write decision stay in Rust. New
device behavior belongs in `bluetooth.rs`/`protocol.rs`, not in the Kotlin plugin.

### Write safety invariants

This is the part of the codebase that matters most; preserve it when touching the write path.

- Before an EQ write, `prepare_eq_write` reads the device's current EQ, stores it as a durable
  snapshot, and aborts if that snapshot cannot be created or verified. `SnapshotStore::ensure`
  uses `create_new` and never truncates an existing backup, so a corrupt file blocks writes
  instead of being silently overwritten.
- Writes are never automatically retried. A missing acknowledgement does not imply failure, so
  every write is followed by a readback and `ConnectionStatus.eq_write_state` resolves to
  `verified`, `different`, or uncertain. The latter two return errors telling the user to review
  or restore, never to resend.
- `confirm_write_target` re-reads firmware immediately before writing and rejects if the device
  or firmware changed since the review. Callers pass the address and firmware the user saw.
- `custom_mode_confirmed` must be true for EQ writes: there is no verified command to switch the
  headphones into Custom EQ mode, which is why the UI requires selecting it in Nothing X first.
  `gain_trial_confirmed` follows the same pattern. Spatial writes always receive `confirmed: true`
  from the UI with no consent dialog; the write is still guarded by the device-name restriction,
  target re-read and mode readback. The home-page output-gain card was removed from the UI (the
  EQ preamp is the only gain control), so `set_bluetooth_gain` / `undo_bluetooth_gain` have no UI
  callers.
- Gain steps are ±1 dB only, are checked to be exactly representable in f32 at the current
  preamp, and are staged to `last-gain-change.json` before the write so undo can detect
  third-party edits.
- Spatial writes are restricted to a device whose name contains `cmf headphone pro`; unknown
  mode values are surfaced, never coerced to Off.

### Connection polling

Full settings (EQ, battery, ANC, spatial) are read exactly once, at connect time
(`read_settings` inside `Controller::connect`). There is no periodic full refresh and no
manual re-read button; recovery from bad readbacks is disconnect/reconnect. The only
periodic traffic is `refresh_battery` — a single `0xc007` battery request every 5 minutes
while connected, visible, idle, and dialog-free — which doubles as the link liveness check
(a transport failure drops the session and the UI offers reconnect). `refresh_headphones`
still exists as a Tauri command but has no UI caller. Battery parsing is tolerant of a
stale record-count byte and unknown single-record IDs (see `decode_battery`/`apply_battery`).

### UI

`ui/index.html` + `app.mjs`, split into `tuning.mjs` (presets, tone-slider→filter mapping,
headroom estimate, `.txt` export), `response.mjs` (RBJ biquad magnitude), `graph-editor.mjs`
(draggable SVG response editor), and `profile-library.mjs`. Every EQ change is a *draft* until
the user confirms Apply — the graph editor in particular never invokes Tauri. Keep it that way.

Constraints from `tauri.conf.json`: the CSP is `script-src 'self'`, so no inline scripts, no CDN,
no new dependencies; fonts are bundled in `ui/fonts/`. The desktop window is a fixed, undecorated
460×760 panel, so the layout must keep all eight bands visible without page scrolling. Use compact
Controls / Equalizer / Profiles tabs.

### Storage

Under Tauri's `app_data_dir`: `profiles/` (one JSON per saved profile, plus a `.library.lock`
handle) and `eq-backups/<ADDRESS>/<hex-encoded-firmware>/original-eq.json` alongside
`last-gain-change.json`. Firmware text is hex-encoded into the path so device-supplied strings
can never contribute path components.

### Android specifics

`tauri.android.conf.json` overrides only the window and bundle settings; `capabilities/` splits
Windows-only window permissions from the Android plugin permission. Android file import/export
goes through SAF in Kotlin (`importText`/`exportText`, reached via `android_transport.rs`), so the
desktop `import_autoeq`/preview paths are not used there.

## Conventions

- Four-space Rust, `snake_case`; `rustfmt` is not configured and files are hand-wrapped.
- Rust errors are user-facing sentences (`Result<_, String>`) that usually name the next safe
  action. Match that tone rather than introducing error codes.
- User-facing copy must not overstate certainty: responses are "calculated" previews, band counts
  and peaks are estimates. The UI labels these carefully — keep it that way.
- Device-visible strings are limited to 128 characters with no control characters
  (`read_text` enforces it).
- `artifacts/`, `research/`, `vendor/`, and `gen/` are ignored and may hold private captures.