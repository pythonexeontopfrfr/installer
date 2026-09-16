/**
 * installer.js - turns a `.tgz` update package into an installed firmware.
 *
 * Flow (identical to what qFlipper / `scripts/selfupdate.py` do over USB):
 *   1. download the update package (or take a local file)
 *   2. gunzip + untar it in the browser (assets/archive.js)
 *   3. push every file to /ext/update/<bundle> through the CLI (assets/serial.js)
 *   4. run `update install /ext/update/<bundle>/update.fuf`
 *
 * The device then verifies the package, reboots into the RAM-resident updater and
 * flashes itself. Nothing about this needs DFU mode or a special firmware.
 */

import { extractUpdatePackage } from './archive.js';
import { SerialError } from './serial.js';

const GITHUB_API = 'https://api.github.com';
/** Where the installer keeps the package on the SD card. */
export const UPDATE_ROOT = '/ext/update';

const formatBytes = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
};

/** Map a firmware target number (from `device_info`) to the release artifact prefix. */
export function targetName(firmwareTarget) {
    if (firmwareTarget === 7) return 'f7';
    if (firmwareTarget === 18) return 'f18';
    return null;
}

/**
 * List releases from a GitHub repository.
 * `repo` must be "owner/name". Draft releases are filtered out by the API itself.
 */
export async function fetchReleases(repo) {
    const response = await fetch(`${GITHUB_API}/repos/${repo}/releases?per_page=30`, {
        headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) {
        throw new Error(
            `Could not read releases of "${repo}" (HTTP ${response.status}). ` +
                'Check assets/config.js -> CONFIG.repo.'
        );
    }
    const releases = await response.json();
    return releases
        .filter((release) => !release.draft)
        .map((release) => ({
            tag: release.tag_name,
            name: release.name || release.tag_name,
            prerelease: release.prerelease,
            publishedAt: release.published_at,
            notes: release.body || '',
            htmlUrl: release.html_url,
            assets: release.assets.map((asset) => ({
                name: asset.name,
                size: asset.size,
                url: asset.browser_download_url,
            })),
        }));
}

/** Find the `flipper-z-<target>-update-*.tgz` asset of a release. */
export function findUpdateAsset(release, target) {
    const pattern = new RegExp(`-f${target}-update-.*\\.tgz$`, 'i');
    return release.assets.find((asset) => pattern.test(asset.name)) ?? null;
}

/** Find the `flipper-z-<target>-full-*.dfu` asset (manual/recovery flashing). */
export function findDfuAsset(release, target) {
    const pattern = new RegExp(`-f${target}-full-.*\\.dfu$`, 'i');
    return release.assets.find((asset) => pattern.test(asset.name)) ?? null;
}

/** Download a URL with progress reporting (falls back to a plain fetch). */
export async function downloadWithProgress(url, { onProgress = () => {}, signal } = {}) {
    const response = await fetch(url, { signal });
    if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
    }
    const total = Number(response.headers.get('content-length')) || 0;

    if (!response.body) {
        const buffer = await response.arrayBuffer();
        onProgress(buffer.byteLength, buffer.byteLength);
        return new Uint8Array(buffer);
    }

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        onProgress(received, total);
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

/**
 * The whole flash sequence, driven step by step so the UI can report progress.
 *
 * @param {object}   options
 * @param {FlipperSerial} options.serial      connected FlipperSerial instance
 * @param {Uint8Array} options.packageBytes   raw `.tgz` contents
 * @param {object}   options.device           parsed device info (may be null)
 * @param {string}   [options.dirName]        override the SD folder name
 * @param {(msg: string) => void} [options.onLog]
 * @param {(step: string, progress: number) => void} [options.onProgress]
 *        progress is 0..1 across the whole upload
 */
export async function installUpdatePackage({
    serial,
    packageBytes,
    device = null,
    dirName = null,
    onLog = () => {},
    onProgress = () => {},
}) {
    onLog(`Extracting ${formatBytes(packageBytes.length)} update package...`);
    const bundle = await extractUpdatePackage(packageBytes);
    onLog(
        `Package "${bundle.rootDir}" contains ${bundle.files.length} files ` +
            `(${formatBytes(bundle.totalSize)} unpacked).`
    );

    if (device?.firmwareTarget) {
        const expected = targetName(device.firmwareTarget);
        const manifestText = new TextDecoder().decode(bundle.manifest.bytes);
        const match = /^Target:\s*(\d+)/m.exec(manifestText);
        const packageTarget = match ? Number(match[1]) : null;
        if (packageTarget && expected && packageTarget !== device.firmwareTarget) {
            throw new Error(
                `This package is built for hardware target f${packageTarget}, but your device ` +
                    `reports f${device.firmwareTarget}. Download the matching build.`
            );
        }
    }

    const folder = dirName || bundle.rootDir;
    const targetDir = `${UPDATE_ROOT}/${folder}`;

    const free = await serial.freeSpace('/ext');
    if (free < bundle.totalSize * 1.1) {
        throw new Error(
            `Not enough space on the SD card: ${formatBytes(free)} free, ` +
                `${formatBytes(bundle.totalSize)} needed.`
        );
    }

    if (await serial.exists(targetDir)) {
        onLog(`Removing the previous copy in ${targetDir}...`);
        await serial.remove(targetDir);
    }
    await serial.mkdirp(targetDir);

    let uploaded = 0;
    for (const file of bundle.files) {
        onLog(`Uploading ${file.path} (${formatBytes(file.size)})...`);
        await serial.writeFile(`${targetDir}/${file.path}`, file.bytes, (sent) => {
            onProgress('upload', Math.min(1, (uploaded + sent) / bundle.totalSize));
        });
        uploaded += file.size;
        onProgress('upload', Math.min(1, uploaded / bundle.totalSize));
    }

    onProgress('apply', 0);
    onLog('Verifying and applying the update on the device...');
    const answer = await serial.applyUpdate(`${targetDir}/update.fuf`);
    if (/^error(\r|\n|$)/i.test(answer) || answer.includes('Storage error:')) {
        throw new SerialError(
            answer.replace(/^error\r?\n?/i, '').trim() ||
                'The device rejected the update package.'
        );
    }
    onProgress('apply', 1);
    onLog('The device is rebooting to install the firmware. Do not unplug it.');
    return { folder, targetDir, files: bundle.files.length, totalSize: bundle.totalSize };
}

/** Helper used by the UI: wait for the reboot and report the outcome. */
export async function waitForInstallResult(serial, { onLog = () => {}, timeoutMs = 45000 } = {}) {
    const rebooted = await serial.waitForReboot(timeoutMs);
    if (rebooted) onLog('Flipper rebooted. The update is being applied.');
    else onLog('The device did not disconnect yet, it may still be flashing. Wait a bit.');
    return rebooted;
}
