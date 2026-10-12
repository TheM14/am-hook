# CHANGELOG

## v0.4.3 (2026-10-12)

### New
- ✨ Songs without a master m3u8 (wrapper-lite `/m3u8` only gives an `.m4p`, e.g. `1569279827`) can be played and downloaded: as in apple-music-downloader, they use the AAC-LC 256 stream from `/webplayback` (Widevine)
  - The song page lists the single "AAC · 256 kbps" variant tagged "AAC-LC only"; batch downloads take it whatever the quality settings (marked as a fallback when another quality was preferred)
  - The Widevine license request is built in the media Worker (new `widevine` module in `am-media`, a port of the reference CDM and its built-in device, sharing `media_challenge` / `media_license` with the MV PlayReady path); PlayReady is tried if Widevine fails
  - Fragments are CENC-decrypted in place (same length) by the existing Worker pool, so playback, seeking, downloads and tags follow the song pipeline

### Changed
- `/mv/license` (and the serverless one) also accepts Widevine requests without `drm-type`
- `media_challenge` takes a new first argument selecting the DRM (0 PlayReady, 1 Widevine)
- Smaller wasm: `media.wasm` 465 → 306 KB, `hook.wasm` 242 → 213 KB, `flac.wasm` 45 → 33 KB
  - `hook.wasm` and `media.wasm` use a new `wasm` profile (size-optimized, with the decryption hot spots temari and AES kept at opt-level 3): FairPlay / CENC decryption speed is unchanged, MV decryption in `media.wasm` is about 8% slower
  - The fixed decryption template embedded in `hook.wasm` is binary (`fixed_template.bin`, generated from `fixed_template.json` and checked by a test) instead of 56 KB of base64 JSON
  - `flac.wasm` now goes through wasm-opt too; `scripts/build-wasm.sh` takes the wasm-opt command from `WASM_OPT` and warns when it is missing

## v0.4.2 (2026-10-12)

### New
- ✨ Music videos in albums and playlists can be downloaded with them: the download dialog lists them (checked by default, with a one-click "Skip music videos"), single music videos can be downloaded from their More menu, and progress shows in the download center
  - As in apple-music-downloader, the video (max resolution, 2160p by default) and audio (Atmos → AC-3 → AAC / AC-3 → AAC / AAC only) are picked by the new Music videos group in Settings; files use the album / playlist track templates with an `.mp4` extension
  - Tags follow the reference `writeMVMP4Tags`: title, artist, album (from the album or playlist), disc / track numbers, release date, ISRC, UPC, copyright, label, rating, `PERFORMER` and `RELEASETIME`, with the MV thumbnail as cover art; the media type is Music Video (`stik` 6)
- ✨ The MV page's own download is tagged the same way

### Changed
- MV downloads are no longer time-interleaved: the video track is downloaded before the audio track, and defrag lays the file out like the reference `mv.Mux`, one chunk per trun with tracks one after another (`defrag::Options::mv` only changes the ftyp)
- MV downloads keep 4 segment requests in flight (decryption and writing stay in order) instead of waiting for each segment
- MVs packed into a ZIP get their CRC-32 while defrag writes them, so the file is not read a second time

## v0.4.1 (2026-10-12)

### Changed
- Album, playlist, artist and library playlist headers keep only Shuffle, Play and More: download, favorite, add to library, edit playlist, artist info and the rest moved into the More menu
- More menus now use the music.apple.com amp-contextual-menu style: frosted material, label on the left and icon on the right; on phones a 270px sheet centered at the bottom over a scrim

### Bug Fixes
- 🐛 Shuffle and Download buttons overlapping on album and playlist pages on phones

## v0.4.0 (2026-10-12)

### New
- ✨ Settings (`/settings`, below Top Charts in the sidebar and the phone menu): general and download settings (quality, performance, save mode, file name templates, tags, cover art, lyrics), stored in the browser
- ✨ Batch downloads of albums and playlists: the download button on album and playlist pages picks the quality and tracks; songs, albums and playlists can also be downloaded from every More menu
  - Full iTunes tags, cover art and lyrics (LRC, optionally word-timed, with translation / pronunciation lines), plus optional `cover.jpg` and `.lrc` / `.ttml` files
  - Saved as a ZIP (with ZIP64), into a local folder (File System Access API, optionally skipping existing files) or as separate files; playlists can include an `.m3u8`
- ✨ Download center: stays at the bottom like the player bar with overall progress and speed, and expands to every track's progress with cancel, retry, save again and remove

### Changed
- "Download decrypted file" on the song page now goes through the download manager, so it is tagged with metadata, cover art and lyrics and shows in the download center
- The `media.wasm` defrag can write ilst tags while building `moov` (`media_defrag` takes a tags argument) and computes CRC-32 while writing

## v0.3.2 (2026-10-10)

### New
- ✨ Deployable to a serverless platform (Vercel or Cloudflare Workers) without running the binary; the README has one-click deploy buttons
  - The platform hosts the static assets and the backend is a single function (`serverless/core.mjs`): the amp-api catalog proxy and the MV master fetch; amp-api responses are cached by the platform
  - By default the browser talks to your own wrapper-lite directly (local mode); set the `AM_HOOK_WRAPPER_URL` environment variable (and optionally `AM_HOOK_WRAPPER_AUTH`) to have the function relay instead, without rate or concurrency limits, so restrict access with the platform's access control
  - `node scripts/build-static.mjs` builds `dist/` from the asset table in `src/assets.rs`; the build needs only Node

### Changed
- New `/assets/host.js` tells the page whether the server can relay wrapper-lite; when it cannot, the "wrapper-lite" setting only offers "Local". The binary behaves as before

## v0.3.1 (2026-10-09)

### Changed
- Code quality pass with no functional change: `cargo clippy --workspace --all-targets -- -D warnings` is warning-free and now runs in CI
  - Embedded front-end assets are registered from a single table in `src/assets.rs`; unknown `/assets/views|lyrics|mv/*` paths now return a plain-text 404, and MV JS / CSS responses carry `charset=utf-8`
  - `src/m3u8.rs` is renamed `src/links.rs` (it only handles links and page paths), and shares its path regex fragments with the request log
  - temari's FFI exports are `unsafe extern "C"` with `# Safety` docs (C ABI unchanged)

### Bug Fixes
- 🐛 temari panicked when a `\u` escape in JSON was followed by a multi-byte character (surfaced as NULL over FFI); the escape is now ignored

## v0.3.0 (2026-10-09)

### New
- ✨ The web page can use your own local wrapper-lite: switch the "wrapper-lite" setting at the bottom of the navigation to "Local" and the browser sends wrapper-lite requests itself
  - URL, max requests per second, max concurrent requests and `Authorization` are configurable and saved in the browser
  - The URL may carry credentials (such as `https://<token>@host`), sent as `Authorization: Basic …` as with `--wrapper-url`
  - The wrapper-lite must allow cross-origin requests, or install a browser extension that lifts CORS restrictions
  - MV master playlists are still fetched by the server with `User-Agent: AM` (new `/parse/mv-master` endpoint) so 4K stays available

### Changed
- The song master m3u8 is now fetched and parsed in the browser; `/parse/song/<adamId>` returns only the master URL (`{"code":0,"data":{"masterUrl":…}}`) instead of `variants`

## v0.2.7 (2026-10-09)

### Removed
- 🗑️ The `--hook` server-side decrypting proxy; decryption now happens only in the browser
  - The `--hook`, `--cache-ttl`, `--lru-cache-mb`, `--prefetch` and `--template-timeout` flags are gone; remove them from startup scripts
  - The song page no longer offers external players, Copy URL or download via server; the built-in player no longer uses native HLS or a direct media file

## v0.2.6 (2026-10-07)

### Bug Fixes
- 🐛 On phones, after tapping the lyrics view the lines above and below the current one stayed unblurred
- 🐛 Visible color banding in the gradients of the classic lyrics background

## v0.2.5 (2026-10-07)

### New Features
- ✨ The lyrics options menu switches the lyrics view's background between AMLL's flowing mesh gradient (default) and the classic background used before AMLL (rotating, twisted and blurred copies of the artwork, modeled on Apple Music Web)
  - The choice is saved in the browser; without WebGL the classic background is used
  - On portrait phone screens the classic background drifts a little faster, closer to how it looks on desktop

## v0.2.4 (2026-10-07)

### New Features
- ✨ On phones, the lyrics view hides the playback controls and the lyrics translation button during playback, and the lyrics extend to the bottom of the screen
  - They hide after 3 seconds without touch or on an upward swipe, and come back on a downward swipe, a tap or when paused
  - While they are hidden, tapping a lyric line only brings them back; tap again to jump to that line

### Bug Fixes
- 🐛 On phones, the left edge of the lyrics did not line up with the artwork above

## v0.2.3 (2026-10-06)

### Bug Fixes
- 🐛 With ALAC-to-FLAC playback, high-bitrate tracks such as 24-bit/96 kHz stalled around 22 seconds until the progress bar was dragged
  - The read-ahead window now follows the measured bitrate, and played audio is removed before appending, so the browser no longer drops unplayed audio to stay within its quota
  - When playback stops with nothing buffered at the play position, it re-buffers from there automatically

## v0.2.2 (2026-10-06)

### New Features
- ✨ The lyrics translation button is now a lyrics options menu
  - Adjust lyrics text size (70%–150%) and font weight (Light to Heavy)
  - Switch the lyrics source between Apple Music and the [AMLL TTML DB](https://amll.dev/reference/http-api/overview): looked up by Apple Music song ID, falling back to Apple Music lyrics for songs it doesn't have; it is only contacted when chosen
  - Download the TTML lyrics being shown
  - Text size, font weight and lyrics source are saved in the browser
- ✨ Read the AMLL TTML DB dialect (inline translations and romanizations, background vocal translations) and credit its lyric authors

### Bug Fixes
- 🐛 Clicking a song on the Favorite Songs page played the wrong track

## v0.2.1 (2026-10-06)

### Bug Fixes
- 🐛 Compare versions numerically; v0.10.0 and later were treated as older releases
- 🐛 Check for updates in the background with timeouts, so an unreachable GitHub no longer delays startup
- 🐛 Report a clear HTTP error on non-2xx responses such as GitHub API rate limiting
- 🐛 `--auto-update` on an unsupported platform now reports an error instead of crashing
- 🐛 On Linux/macOS the executable is replaced atomically; it stays intact if any step fails
- 🐛 The Windows manual update steps name the actual exe file

### Other
- CI runs tests for the whole workspace; end-to-end tests that need the live CDN / wrapper-lite are ignored by default
- Upgraded GitHub Actions to current versions (Node.js 24)

## v0.2.0 (2026-10-05)

### New Features
- ✨ Added auto-update functionality
  - Use `--check-update` to check for updates on startup
  - Use `--auto-update` to automatically download and install the latest version
- 🚀 Added GitHub Actions automated build workflow
  - Automatically builds multi-platform binaries when tags are pushed
  - Supports Windows (x86_64), Linux (x86_64), macOS (x86_64 and aarch64)

### Usage

#### Check for updates
```sh
am-hook --check-update --listen 0.0.0.0:8888 --wrapper-url http://127.0.0.1:12340
```

#### Auto-update
```sh
am-hook --auto-update --listen 0.0.0.0:8888 --wrapper-url http://127.0.0.1:12340
```

### Releasing a new version

1. Update the version number in `Cargo.toml`
2. Create and push a tag:
```sh
git tag v0.2.0
git push origin v0.2.0
```
3. GitHub Actions will automatically build and create a Release

### Notes

- On Windows, since the running executable cannot be replaced, auto-update will download the new version to `am-hook-new.exe`. Manual restart is required to complete the update.
- On Linux and macOS, the executable will be automatically replaced, with the old version backed up as `am-hook-backup`.

---

## v0.1.0

Initial release
