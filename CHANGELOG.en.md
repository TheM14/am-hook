# CHANGELOG

## v0.5.8 (2026-10-22)

### New
- ✨ Settings: a "Fallback order" list under "Fall back when missing" shows the preferred quality and the qualities tried after it; each can be moved up / down or removed, others added, and "Default" restores the built-in order. Orders are saved per preferred quality, so a quality picked in the download dialog uses its own; an empty order means no fallback
- ✨ The download center shows ALAC check results in full (no truncation; on narrow screens they wrap under the title with the quality), and album / playlist cards show a check summary

### Fixes
- 🐛 Songs without a master only have the Widevine AAC-LC 256 from `/webplayback` (e.g. cn `1569279827`) and were downloaded at AAC 256 whatever the settings: they now follow the same order as other qualities and are downloaded only when AAC 256 is preferred or in the fallback order, otherwise skipped

### Changed
- ⚡ Songs that amp-api marks `hasLyrics: false` no longer request lyrics from wrapper-lite; a failed lyrics fetch (other than 404) is tried up to 3 times, 1 s and 2 s apart, and stops at once when the download is cancelled

## v0.5.7 (2026-10-21)

### New
- ✨ "Check ALAC" can also check the master m3u8 from wrapper-lite: it may be packaged differently from the web API's (amp-api `enhancedHls`) and sometimes has a better ALAC (`1679278167`: 24/48 on the web, also 24/96 via wrapper-lite). The same best ALAC is checked once; different ones are both listed and the better one is marked
- ✨ ALAC check on playlist and song pages and in songs' More menu (albums, playlists, search and more)
- ✨ The song page compares the web API's master with wrapper-lite's, tags qualities only wrapper-lite has and can copy the web master URL
- ✨ Settings: turn off the ALAC END-tag repair of downloads; check ALAC while downloading and write the result to a custom tag (`ALAC_CHECK` by default), also shown in the download center; the check reads the downloaded data itself, with no extra requests

### Changed
- 💄 The check dialog no longer starts by itself: select all, none or some tracks; it shows the region, the album / playlist / song ID, song IDs and the check time; the options are one line of short labels with the explanations under "About", and each source's result is a card

## v0.5.6 (2026-10-20)

### New
- ✨ "Check ALAC" on album pages (the waveform button next to Play and Shuffle): finds the escape frames whose end was overwritten in every track's best ALAC stream ([AppleMusicDecrypt#136](https://github.com/WorldObservationLog/AppleMusicDecrypt/issues/136)), without wrapper-lite and without requesting `/key`
  - The master m3u8 comes from amp-api's `extendedAssetUrls.enhancedHls`; only each segment's moof is downloaded, plus the last 4 bytes (the part cbcs leaves unencrypted) of samples larger than one frame of PCM, about 80 KB for a 16-bit / 44.1 kHz track
  - Tells "END tag missing" (FFmpeg and others drop the frame) from "Hidden damage" (the END tag happens to be `111` but the padding is not zero: it decodes, but the last sample is wrong), lists frame numbers, times and the last 4 bytes, and copies a text report
  - Shows the packaging date (creation time in the init segment's `mvhd`) and the packager version (`swre`)
  - Optionally decrypts the first segment (about 15 s) with the fixed key and decodes it to measure the real bit depth (low bits always zero?) and bandwidth (highest frequency above the quantization noise; a steep drop suggests upsampling or a lossy source), with a spectrum chart

### Changed
- 📝 The README now describes the ALAC end-tag repair accurately: restoring the END tag only stops decoders from dropping the frame; the overwritten last sample cannot be restored

## v0.5.5 (2026-10-19)

### Changed
- 💄 The player bar is rebuilt after music.apple.com as a floating glass pill (56px tall, at most 720px wide): playback controls, an LCD, and actions
  - The LCD has 34px artwork, a two-line marquee and a 2px progress line that expands to 7px with times on hover or drag
  - Volume becomes a speaker button with a slide-out slider; click to mute
  - Playback notices (FLAC transcoding, multichannel PCM) move into a popover behind the mode badge, shown automatically only the first time; playback errors float above the bar
  - Compact mini-player layout at 760px and below
- 💄 The song page is rebuilt after music.apple.com
  - Header: 208px artwork (300px at 1260px and up) with a glow, centred on phones; title, linked artists, album · year · genre and audio-trait badges; the page is tinted with the artwork colour like the album page
  - The Play button turns into Pause while the song plays; a favourite button and a More menu (library, playlists, download, copy links, open in Apple Music) replace the row of buttons
  - The quality list is grouped by format in rounded cards, with rows styled like album track rows; each row has a download button whose progress ring cancels on click; the More menu adds "Copy m3u8 link"; skeleton rows while loading
  - New Credits, Information, Music Videos and More By sections

## v0.5.4 (2026-10-19)

### New
- ✨ Preferred quality adds AAC 128 kbps, AAC Binaural 128 kbps, HE-AAC Binaural 64 kbps, AAC Downmix 128 kbps and HE-AAC Downmix 64 kbps (Apple's masters already carry them; previously the highest bitrate of a kind was always taken), 11 choices in all. The menu in Settings and the download dialog is grouped as Lossless & Dolby Atmos / AAC Stereo / AAC Binaural / AAC Downmix, and the description gives rough file sizes per minute. Each new choice has its own fallback order, e.g. a stereo-only song asked for Binaural 128 gets HE Binaural, then Stereo 128 (#4)
- 📝 README links the Telegram group [@apple_music_alac](https://t.me/apple_music_alac)

### Fixes
- 🐛 Some older music videos (e.g. 1175186184) have media playlists without `EXT-X-KEY` and failed with "No PlayReady media found"; they now play and download

## v0.5.3 (2026-10-19)

### New
- ✨ `--client-concurrency`: max wrapper-lite requests relayed at once per client IP (`/status` not counted); further requests wait instead of failing. Together with the per-minute `--client-rate`, one visitor's burst can no longer hold every `--wrapper-concurrency` permit and stall everyone else. Waiting requests are logged as `QUEUED … by client concurrency`

### Fixes
- 🐛 `/status` is not counted by `--client-rate`, yet a client could keep requesting it and every request reached wrapper-lite, using up `--wrapper-rate` and concurrency permits: all clients now share one result for 10 s and simultaneous requests are merged, so wrapper-lite gets at most one `/status` per 10 s; the upstream `/status` also has a 10 s timeout

## v0.5.2 (2026-10-19)

### New
- ✨ `--client-rate`: max relayed wrapper-lite requests per client IP in any 60 seconds (`/status` not counted); further requests get HTTP 429 with `Retry-After` and never reach wrapper-lite, so one visitor (e.g. batch-downloading whole artists) cannot use up a shared wrapper-lite; rejected requests are logged as `client <ip> over N/min`
- ✨ `--client-ip-header`: take the client IP from a header set by the reverse proxy (e.g. `X-Real-IP`, `CF-Connecting-IP`); the TCP peer address by default

### Fixes
- 🐛 wrapper-lite concurrency limit: a request that timed out, failed while reading the response, or was cancelled (client disconnected) returned its permit at once while wrapper-lite might still be processing it, so under a slow upstream the real concurrency exceeded `--wrapper-concurrency` (a public wrapper-lite then answered `rate limited (concurrency)` and later `banned`). Such permits are now held for 30 more seconds; a complete reply or a connect failure still returns it at once. The `wrapper-lite THROTTLED` line shows the held count

## v0.5.1 (2026-10-19)

### New
- ✨ `--local-wrapper-only`: the binary no longer relays wrapper-lite; pages only connect from the browser (as on a serverless deployment without `AM_HOOK_WRAPPER_URL`), and `--wrapper-url` / `--wrapper-rate` / `--wrapper-concurrency` become the page's local-mode defaults
- ✨ `--wrapper-hint` (`AM_HOOK_WRAPPER_HINT` on serverless): an operator note above the local wrapper-lite settings; URLs in it become links
- ✨ wrapper-lite queueing in the console: while requests wait, a `wrapper-lite THROTTLED` line every second (sent in the last second / limit, in flight, queued), and a summary when the queue empties; queued requests are marked `QUEUED … by rate limit / concurrency limit` in the request log

### Fixes
- 🐛 wrapper-lite rate limit: a queued request cancelled while waiting (browser abort or disconnect) let one extra request through, which could exceed `--wrapper-rate` within that second

## v0.5.0 (2026-10-18)

### New
- ✨ Radio (`/radio`, between Top Charts and Settings in the sidebar and phone menu): the editorial sections of music.apple.com/{cc}/radio, with a LIVE badge and the show on air on the live radio shelf; with a media-user-token, Your Stations (the personal station and recently played) comes first
- ✨ Station pages (`/https://music.apple.com/<cc>/station/<slug>/ra.<id>`); station links on New, editorial pages and Radio open them here:
  - Personal and editorial stations: the playlist track list holding the station's next songs, with a new batch or more on demand; playback fetches the next batch before the queue runs out (new `more` option of `AmPlayer.playQueue`)
  - Episodes (audio or video): the music video layout, with playback, seeking and downloads as M4A / MP4 (tagged with title, show, air date and artwork)
  - Live radio: the music video layout, playing near the live edge with the song on air (ID3 in the segments' emsg) and the schedule
- ✨ Stations need the media-user-token of an Apple Music account (wrapper-lite does not support stations yet): the first station page asks for it (a whole Cookie header also works), checks it and keeps it only in the browser; a rejected token is asked for again, and Settings can change or clear it
- ✨ New station endpoints on the server (binary and serverless): `/station/next-tracks/<id>`, `/station/assets`, `/station/catalog/...`, `/station/recent` and `/station/storefront` call amp-api with the media-user-token (never cached), and `/station/license` sends Widevine / PlayReady license requests shaped as MusicKit does straight to Apple's license servers

### Changed
- The MV engine's download is split into a shared `downloadStreams` (used by MVs and episodes; a single stream keeps its own track)

## v0.4.9 (2026-10-18)

### Bug Fixes
- 🐛 Saving to a folder failed for names that start or end with `~` (e.g. the album "A COMPLETE ~ALL SINGLES~": `Failed to execute 'getDirectoryHandle'`): name sanitizing now follows Chrome's rules, replacing a leading or trailing `~` with the full-width `～` and removing leading and trailing dots and whitespace (including the ideographic space), C1 control characters, format characters (zero-width spaces, direction marks, etc.), noncharacters and lone surrogates; `.lnk` / `.local` / `.{…}` extensions and reserved names such as `clock$`, `desktop.ini`, `thumbs.db` and `COM¹` are renamed too
- 🐛 Saving failed for overly long names: each name is capped at 240 bytes (UTF-8; macOS / Linux allow 255 bytes, which long Japanese titles used to exceed), and the path below the chosen folder at 150 characters with album / playlist folders at 90, to stay within the 260-character Windows path limit (including Chrome's `.crswap` temporary suffix); when over, the longest segment is shortened first
- 🐛 The file name previews in Settings show the shortened result actually used

## v0.4.8 (2026-10-18)

### Bug Fixes
- 🐛 Downloaded songs skipped from about 13 s to 15 s in VLC: Apple Music gives the first ~15 s (prefetch key) and the rest (real key) separate sample descriptions, which are identical once decrypted, but the chunks switch description index at 15 s, so VLC recreates the decoder and drops the ~2 s of audio it had buffered. Defrag now merges identical `stsd` entries so the whole song uses one description index (AAC, ALAC and Atmos alike)

## v0.4.7 (2026-10-15)

### Bug Fixes
- 🐛 `type="replacement"` lyric localizations (e.g. a zh-Hans-CN replacement for zh-Hant lyrics) replace the main lyrics instead of showing as a translation; word-synced lyrics keep the replacement's own word timing, so downloaded word-synced LRC no longer falls back to line-synced
- 🐛 Unsynced lyrics (`timing="None"`) open at the top of the lyrics view instead of scrolling to the end

## v0.4.6 (2026-10-13)

### Bug Fixes
- 🐛 The binary's 404s also carry `no-store` (as on serverless deployments): behind a CDN (such as the Cloudflare proxy), the 404 for a missing content-hashed URL is not cached, so rolling back a version cannot leave the page stuck on a cached 404

## v0.4.5 (2026-10-13)

### Bug Fixes
- 🐛 On serverless deployments, the 404 for a missing content-hashed URL (an old page asking for a version that is gone) also carried `immutable`, so after rolling back to that version browsers kept the cached 404: such requests now reach the function, which returns a `no-store` 404
- 🐛 Vercel deployments no longer expose `/_headers`: `build-static` writes it only with `--cloudflare` (the `wrangler.toml` build command)

## v0.4.4 (2026-10-13)

### Changed
- ⚡ Front-end assets are loaded by content-hashed URLs (`/assets/h/app.<hash>.mjs`) cached as `immutable`, so pages, modules, Workers and wasm are no longer revalidated (304) on every load
  - References between text assets (`/assets/...` and `./x.mjs` relative paths) are rewritten to the hashed URLs by the server and by `build-static`; hashes cover the rewritten content, so a changed dependency also changes the URLs of the assets referencing it
  - The app shell stays `no-cache` and points at the new URLs right after an upgrade; original URLs are still served with `no-cache` + ETag; serverless deployments set the cache headers in `vercel.json` and `dist/_headers` (Cloudflare)
- ⚡ Workers are reused during batch downloads and playback: song defragmentation, OPFS writing, MV download and FLAC transcoding Workers are kept after a job (terminated after 30 s idle) instead of refetching and recompiling `media.wasm` and the others for every song

### Bug Fixes
- 🐛 A transient wrapper-lite `/m3u8` error (such as HTTP 500) during batch downloads downgraded the song to AAC-LC 256: `/webplayback` is now used only when `/m3u8` returns an `.m4p`, and failed requests are reported and retried

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
