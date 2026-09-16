/**
 * config.js - everything you need to change after forking.
 *
 * The installer reads releases from GitHub, so point `repo` at the repository that
 * runs `.github/workflows/release.yml` (the firmware repo).
 * -----------------------------------------------------------------------------
 *   repo:   "pythonexeontopfrfr/slowed.lol"    
 * -----------------------------------------------------------------------------
 * You can also override things without editing this file, which is handy for dev
 * builds and for hosting packages on your own CDN:
 *
 *   /?repo=someone/slowed.lol
 *   /?url=https://example.com/flipper-z-f7-update-slowed-001.tgz
 *   /?version=slowed-001&channel=dev
 */

const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

export const CONFIG = {
    /** Firmware name shown in the UI. */
    firmwareName: params.get('name') || 'slowed.lol',
    /** Short tagline. */
    tagline: params.get('tagline') || 'Custom firmware for Flipper Zero',

    /** GitHub repository that publishes the releases ("owner/name"). */
    repo: params.get('repo') || 'pythonexeontopfrfr/slowed.lol',

    /** Release tag that the "stable" channel points at (empty = newest release). */
    stableTag: params.get('version') || '',

    /** Direct package URL: skips the release list entirely. */
    directUrl: params.get('url') || '',

    /** Where qFlipper / lab.flipper.net / docs live, used by the manual section. */
    links: {
        github: 'https://github.com/',
        qflipper: 'https://flipperzero.one/downloads',
        webUpdater: 'https://lab.flipper.net/',
        docs: 'https://docs.flipper.net/zero/development/firmware',
    },

    /** Serial chunk size used while uploading to the SD card. */
    chunkSize: 8192,
};

export function repoUrl(repo = CONFIG.repo) {
    return `https://github.com/${repo}`;
}

export function isConfigured(repo = CONFIG.repo) {
    return Boolean(repo) && !repo.includes('YOUR_GITHUB_USERNAME');
}
