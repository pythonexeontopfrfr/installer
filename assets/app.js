/**
 * app.js - UI wiring for the slowed.lol web installer.
 * Talks to assets/serial.js (transport), assets/installer.js (update logic)
 * and assets/archive.js (package extraction).
 */

import { CONFIG, isConfigured, repoUrl } from './config.js?v=3';
import { FlipperSerial, parseDeviceInfo, SerialError } from './serial.js?v=3';
import {
    downloadWithProgress,
    fetchReleases,
    findDfuAsset,
    findUpdateAsset,
    installUpdatePackage,
    targetName,
    waitForInstallResult,
} from './installer.js?v=3';

const $ = (id) => document.getElementById(id);

const ui = {
    firmwareName: $('firmware-name'),
    tagline: $('tagline'),
    supportWarning: $('support-warning'),
    connect: $('connect-btn'),
    disconnect: $('disconnect-btn'),
    install: $('install-btn'),
    deviceHint: $('device-hint'),
    deviceFields: $('device-fields'),
    version: $('version-select'),
    versionHint: $('version-hint'),
    file: $('file-input'),
    fileHint: $('file-hint'),
    progress: $('progress-bar'),
    progressLabel: $('progress-label'),
    log: $('log'),
    status: $('status-badge'),
    manualTgz: $('manual-tgz'),
    manualDfu: $('manual-dfu'),
    manualVersion: $('manual-version'),
    sourceGithub: $('source-github'),
};

const state = {
    serial: null,
    device: null,
    releases: [],
    selectedRelease: null,
    directUrl: null, // set from ?url=, the "paste a URL" option, or a mirror
    localPackage: null, // { name, bytes }
    busy: false,
};

function log(message) {
    const stamp = new Date().toLocaleTimeString();
    ui.log.textContent += `[${stamp}] ${message}\n`;
    ui.log.scrollTop = ui.log.scrollHeight;
}

function status(text, kind = 'idle') {
    ui.status.textContent = text;
    ui.status.dataset.kind = kind;
}

function setProgress(label, ratio) {
    const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    ui.progress.style.width = `${percent}%`;
    ui.progressLabel.textContent = `${label} ${percent}%`;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function setBusy(busy) {
    state.busy = busy;
    ui.connect.disabled = busy;
    ui.install.disabled = busy || !state.serial?.isOpen;
    ui.version.disabled = busy;
    ui.file.disabled = busy;
}

/** Human readable description of the current browser, for support hints. */
function describeBrowser() {
    const ua = navigator.userAgent;
    if (/Edg\//.test(ua)) return { name: 'Microsoft Edge', serial: true };
    if (/OPR\//.test(ua)) return { name: 'Opera', serial: true };
    if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return { name: 'Chrome', serial: true };
    if (/Firefox\//.test(ua)) return { name: 'Firefox', serial: false };
    if (/Safari\//.test(ua)) return { name: 'Safari', serial: false };
    if (/Android|iPhone|iPad/.test(ua)) return { name: 'a mobile browser', serial: false };
    return { name: 'this browser', serial: 'serial' in navigator };
}

const NO_SERIAL_MESSAGE = (browser) =>
    `WebSerial is not available in ${browser.name}, so the one-click installer cannot run here.\n\n` +
    `What to do:\n` +
    `  1. Open this page in desktop Chrome, Edge or Opera (they are the only browsers with WebSerial).\n` +
    `  2. Or install manually with qFlipper - scroll down to "Manual installation" for the .tgz/.dfu links.\n` +
    (browser.serial === false
        ? `\n(Firefox, Safari and mobile browsers do not support WebSerial at all.)`
        : '');

/** Render the connected device (or the hint when nothing is connected). */
function renderDevice() {
    const device = state.device;
    if (!device) {
        ui.deviceHint.hidden = false;
        ui.deviceFields.hidden = true;
        ui.deviceFields.textContent = '';
        return;
    }
    ui.deviceHint.hidden = true;
    ui.deviceFields.hidden = false;

    const rows = [
        ['Model', device.model ?? 'unknown'],
        ['Firmware', [device.firmwareVersion, device.firmwareOrigin].filter(Boolean).join(' · ') || 'unknown'],
        ['Target', targetName(device.firmwareTarget) ?? `f${device.firmwareTarget ?? '?'}`],
        ['API', device.api ?? 'unknown'],
        ['Branch', device.firmwareBranch ?? 'unknown'],
        ['Built', device.buildDate ?? 'unknown'],
    ];
    ui.deviceFields.replaceChildren(
        ...rows.map(([label, value]) => {
            const row = document.createElement('div');
            row.className = 'field';
            const dt = document.createElement('span');
            dt.className = 'field-label';
            dt.textContent = label;
            const dd = document.createElement('span');
            dd.className = 'field-value';
            dd.textContent = value;
            row.append(dt, dd);
            return row;
        })
    );
}

/** Fill the version dropdown from the release list, filtered by hardware target. */
function renderVersions() {
    const target = state.device?.firmwareTarget ?? state.device?.hardwareTarget;
    const usable = state.releases.filter((release) => {
        if (CONFIG.stableTag && release.tag !== CONFIG.stableTag) return false;
        return target ? Boolean(findUpdateAsset(release, target)) : true;
    });

    ui.version.replaceChildren();
    if (state.localPackage) {
        const option = document.createElement('option');
        option.value = '__local__';
        option.textContent = `Local file: ${state.localPackage.name}`;
        ui.version.append(option);
        state.selectedRelease = null;
        ui.version.value = '__local__';
    }

    for (const release of usable) {
        const option = document.createElement('option');
        option.value = release.tag;
        const suffix = release.prerelease ? ' (dev)' : '';
        option.textContent = `${release.name}${suffix} — ${new Date(release.publishedAt).toLocaleDateString()}`;
        ui.version.append(option);
    }

    const option = document.createElement('option');
    option.value = '__direct__';
    option.textContent = 'Paste a package URL';

    if (ui.version.options.length === 0) {
        ui.version.append(optionByValue('', 'No release found - use a local file'));
    }
    ui.version.append(option);
    if (state.localPackage) {
        ui.version.value = '__local__';
        state.selectedRelease = null;
    } else if (state.directUrl) {
        ui.version.value = '__direct__';
        state.selectedRelease = null;
    } else {
        state.selectedRelease = usable.find((release) => release.tag === state.selectedRelease?.tag)
            ?? usable[0] ?? null;
        if (state.selectedRelease) ui.version.value = state.selectedRelease.tag;
    }
    updateManualLinks();
    updateVersionHint();
}

function updateVersionHint() {
    const release = state.selectedRelease;
    if (state.localPackage && ui.version.value === '__local__') {
        ui.versionHint.textContent = `Will flash ${state.localPackage.name} (${formatBytes(
            state.localPackage.bytes.length
        )}).`;
        return;
    }
    if (state.directUrl && ui.version.value === '__direct__') {
        ui.versionHint.textContent = `Will flash the package at ${state.directUrl}`;
        return;
    }
    if (!release) {
        ui.versionHint.textContent = isConfigured()
            ? 'No matching build found. Pick a .tgz file manually below.'
            : 'Set CONFIG.repo in assets/config.js, or pick a .tgz file manually below.';
        return;
    }
    const asset = findUpdateAsset(release, (state.device?.firmwareTarget ?? state.device?.hardwareTarget ?? 7));
    ui.versionHint.textContent = asset
        ? `${asset.name} (${formatBytes(asset.size)})`
        : 'No matching hardware-target build in this release.';
}

function updateManualLinks() {
    const target = (state.device?.firmwareTarget ?? state.device?.hardwareTarget ?? 7);
    const release = state.selectedRelease;
    const dfu = release ? findDfuAsset(release, target) : null;
    const tgz = release ? findUpdateAsset(release, target) : null;

    ui.manualVersion.textContent = release ? release.tag : 'latest release';
    for (const [element, asset] of [
        [ui.manualTgz, tgz],
        [ui.manualDfu, dfu],
    ]) {
        if (asset) {
            element.href = asset.url;
            element.textContent = `${asset.name} (${formatBytes(asset.size)})`;
        } else {
            element.href = repoUrl();
            element.textContent = 'not available in this release';
        }
    }
}

/** Load the release list once, then let the device refine it. */
async function loadReleases() {
    if (!isConfigured()) {
        log(
            'config.js still has the placeholder repo. Edit assets/config.js or add ' +
                '?repo=owner/name to the URL.'
        );
        state.releases = [];
        renderVersions();
        return;
    }
    status('Loading releases...');
    try {
        state.releases = await fetchReleases(CONFIG.repo);
        state.releases.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
        log(`Loaded ${state.releases.length} release(s) from ${CONFIG.repo}.`);
        renderVersions();
        status('Ready');
    } catch (error) {
        log(`Release lookup failed: ${error.message}`);
        state.releases = [];
        renderVersions();
        status('Release lookup failed', 'error');
    }
}

async function connect() {
    if (state.busy) return;
    const browser = describeBrowser();
    if (!FlipperSerial.isSupported()) {
        window.alert(NO_SERIAL_MESSAGE(browser));
        ui.supportWarning.hidden = false;
        log(`WebSerial is unavailable in ${browser.name} - use desktop Chrome, Edge or Opera.`);
        return;
    }
    setBusy(true);
    status('Connecting...');
    let serial = null;
    try {
        const port = await FlipperSerial.requestPort();
        serial = new FlipperSerial({ chunkSize: CONFIG.chunkSize, log });
        state.device = await serial.connect(port);
        state.serial = serial;
        log(
            `Connected: ${state.device.model ?? 'Flipper Zero'} running ` +
                `${state.device.firmwareVersion ?? 'unknown firmware'}.`
        );
        renderDevice();
        renderVersions();
        status('Connected', 'ok');
    } catch (error) {
        try {
            await serial?.close();
        } catch {
            /* already gone */
        }
        state.serial = null;
        state.device = null;
        renderDevice();
        status('Not connected', 'error');
        log(`Connection failed: ${error.message}`);
    }
    setBusy(false);
}

async function disconnect() {
    setBusy(true);
    try {
        await state.serial?.close();
    } catch {
        /* ignore */
    }
    state.serial = null;
    state.device = null;
    renderDevice();
    renderVersions();
    status('Disconnected');
    log('Disconnected.');
    setBusy(false);
}

async function resolvePackageBytes() {
    if (state.localPackage) return state.localPackage.bytes;

    if (state.directUrl) {
        log(`Downloading package from ${state.directUrl}...`);
        return downloadWithProgress(state.directUrl, {
            onProgress: (received, total) =>
                setProgress('Downloading', total ? received / total : 0),
        });
    }

    if (!targetName(state.device?.firmwareTarget ?? state.device?.hardwareTarget)) {
        throw new Error('Hardware target is unknown. Reconnect before installing.');
    }
    const release = state.selectedRelease;
    if (!release) throw new Error('No build selected.');
    const asset = findUpdateAsset(release, (state.device?.firmwareTarget ?? state.device?.hardwareTarget ?? 7));
    if (!asset) throw new Error('The selected release has no update package for this device.');

    log(`Downloading ${asset.name}...`);
    return downloadWithProgress(asset.url, {
        onProgress: (received, total) => setProgress('Downloading', total ? received / total : 0),
    });
}

async function install() {
    if (state.busy) return;
    if (!state.serial?.isOpen) {
        log('Connect your Flipper first.');
        return;
    }
    setBusy(true);
    status('Installing...');
    try {
        const bytes = await resolvePackageBytes();
        log(`Package downloaded (${formatBytes(bytes.length)}).`);
        setProgress('Extracting', 0);

        const result = await installUpdatePackage({
            serial: state.serial,
            packageBytes: bytes,
            device: state.device,
            onLog: log,
            onProgress: (step, ratio) =>
                setProgress(step === 'apply' ? 'Applying' : 'Uploading', ratio),
        });

        log(`Uploaded ${result.files} file(s) into ${result.targetDir}.`);
        status('Applying update...');
        await waitForInstallResult(state.serial, { onLog: log });
        setProgress('Done', 1);
        status('Update installed', 'ok');
        log('Done. Your Flipper should now boot the new firmware.');
    } catch (error) {
        status('Install failed', 'error');
        setProgress('Failed', 0);
        log(`Install failed: ${error.message}`);
        if (error instanceof SerialError && error.fatal) {
            log('The device was disconnected. Reconnect it and try again.');
        }
    }
    setBusy(false);
}

function wireEvents() {
    ui.connect.addEventListener('click', connect);
    ui.disconnect.addEventListener('click', disconnect);
    ui.install.addEventListener('click', install);

    ui.version.addEventListener('change', () => {
        const value = ui.version.value;
        if (value === '__direct__') {
            const url = window.prompt('Direct .tgz package URL:');
            if (url) {
                state.directUrl = url;
                state.localPackage = null;
                state.selectedRelease = null;
            } else {
                state.directUrl = null;
                renderVersions();
                return;
            }
        } else if (value !== '__local__') {
            state.directUrl = null;
            state.localPackage = null;
            state.selectedRelease =
                state.releases.find((release) => release.tag === value) ?? null;
        }
        updateManualLinks();
        updateVersionHint();
    });

    ui.file.addEventListener('change', async () => {
        const file = ui.file.files?.[0];
        if (!file) return;
        state.localPackage = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
        log(`Loaded local package ${file.name} (${formatBytes(state.localPackage.bytes.length)}).`);
        renderVersions();
    });
}

function init() {
    ui.firmwareName.textContent = CONFIG.firmwareName;
    ui.tagline.textContent = CONFIG.tagline;
    ui.sourceGithub.href = repoUrl();
    ui.sourceGithub.textContent = isConfigured()
        ? `github.com/${CONFIG.repo}`
        : 'set CONFIG.repo in assets/config.js';
    state.directUrl = CONFIG.directUrl || null;
    if (state.directUrl) {
        log(`A direct package URL is set: ${state.directUrl}`);
    }

    const browser = describeBrowser();
    if (!FlipperSerial.isSupported()) {
        ui.supportWarning.textContent =
            `⚠️ You are using ${browser.name}, which has no WebSerial support. ` +
            'The one-click installer needs desktop Chrome, Edge or Opera — or install manually ' +
            'with qFlipper (see "Manual installation" below).';
        ui.supportWarning.hidden = false;
        log(`WebSerial is unavailable in ${browser.name}.`);
    } else {
        log(`Browser OK: ${browser.name} (WebSerial available).`);
    }
    if (!window.isSecureContext) {
        ui.supportWarning.hidden = false;
        ui.supportWarning.append(
            ' WebSerial also requires HTTPS (or localhost), so open this page over a secure origin.'
        );
    }

    renderDevice();
    wireEvents();
    // Puts the buttons into a sane disabled/enabled state and disables Connect
    // when WebSerial is missing.
    setBusy(false);
    loadReleases();
    log('Installer ready. Plug in your Flipper and press "Connect".');
}

// parseDeviceInfo is re-exported for the debug console of the browser
window.slowed = { parseDeviceInfo, state };

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}


function optionByValue(value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
}
