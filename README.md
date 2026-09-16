# slowed.lol web installer

A Momentum-style browser installer for your custom Flipper Zero firmware.
No build step, no dependencies, no bundler — just static files.

```
website/
├── index.html                 # landing page + 4-step install wizard
├── assets/
│   ├── config.js              # <-- the only file you have to edit
│   ├── app.js                 # UI wiring
│   ├── serial.js              # WebSerial <-> Flipper CLI transport
│   ├── archive.js             # gunzip + USTAR parser for the .tgz package
│   ├── installer.js           # release lookup, download, upload, `update install`
│   └── styles.css
├── tests/
│   ├── archive.test.mjs       # node tests for the tar/gzip layer
│   └── dom-ids.test.mjs       # checks app.js and index.html stay in sync
└── .github/workflows/pages.yml
```

## How the install works

This is exactly what qFlipper and `scripts/selfupdate.py` do over USB; the browser
just speaks the same protocol (`scripts/flipper/storage.py`) itself:

1. the update package (`flipper-z-f7-update-<suffix>.tgz` from your releases) is
   downloaded and gunzipped/untarred **in the browser**;
2. every file is pushed to the SD card with the CLI command
   `storage write_chunk "<path>" <size>`, chunk by chunk;
3. the device is told to verify and apply it: `update install /ext/update/<bundle>/update.fuf`;
4. the Flipper reboots on its own, loads the RAM-resident updater and flashes itself
   (see `documentation/OTA.md` in the firmware repo).

That means no DFU mode, no drivers and no wiped SD card — and it works from the
stock firmware as well as from your own.

## Setup

1. **Edit `assets/config.js`** and set your repository:

   ```js
   repo: 'pythonexeontopfrfr/slowed.lol',
   ```

2. **Host it** — pick any static host, e.g. GitHub Pages with the included workflow
   (Settings → Pages → Source: *GitHub Actions*), Cloudflare Pages, Netlify or Vercel.

3. **Publish a firmware release** in the firmware repo (`git tag slowed-001 && git push --tags`).
   The installer lists releases through the GitHub API, so nothing else to wire up.

### URL parameters (handy for dev builds and mirrors)

| Parameter | Meaning |
|---|---|
| `?repo=owner/name` | read releases from another repository |
| `?version=slowed-001` | pin the installer to one release tag |
| `?url=https://…/flipper-z-f7-update-slowed-001.tgz` | flash a package from any URL |
| `?name=` / `?tagline=` | override the branding text |

Example, exactly like `lab.flipper.net` works:

```
https://your-site.tld/?url=https://github.com/you/slowed.lol/releases/download/slowed-001/flipper-z-f7-update-slowed-001.tgz
```

## Local development

```bash
node tests/archive.test.mjs        # parser tests (8 cases)
node tests/dom-ids.test.mjs        # UI/HTML consistency
node tests/archive.test.mjs path/to/flipper-z-f7-update-slowed-001.tgz
npm run serve                      # http://localhost:3000 (WebSerial needs localhost or HTTPS)
```

## Troubleshooting

- **`Fetch` of the release asset fails (CORS)** — some hosts block cross-origin
  downloads of release assets. Use the file picker in step 3, or mirror the `.tgz`
  next to the site and pass it with `?url=`/`config.js`.
- **Firefox/Safari** have no WebSerial yet; the page still shows the manual
  instructions. Mobile browsers are not supported at all.
- **The upload seems stuck** — the CLI is busy (qFlipper or the mobile app is
  connected). Close them, replug the cable, connect again.

## License

GPL-3.0-only, matching the firmware it installs.
