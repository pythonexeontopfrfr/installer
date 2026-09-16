/**
 * serial.js - WebSerial transport for the Flipper Zero CLI.
 *
 * The Flipper exposes its command line over the USB CDC port, which is exactly what
 * `scripts/flipper/storage.py` (used by `fbt flash_usb`, `scripts/selfupdate.py`, ...)
 * talks to. This class re-implements the same protocol in the browser:
 *
 *   connect   -> wait for the CLI prompt ">: "
 *   command   -> write "<line>\r" and read until the next prompt
 *   writeFile -> "storage write_chunk" + a raw byte stream, as in FlipperStorage.send_file
 *
 * No protobuf/RPC and no DFU mode are required: this works on stock firmware and on
 * any custom firmware, as long as the SD card is inserted.
 */

export const FLIPPER_USB = {
    vendorId: 0x0483,
    productCdc: 0x5740, // STM32 virtual COM port (CLI / qFlipper)
    productDfu: 0xdf11, // device booted into DFU/recovery mode
};

export const CLI_PROMPT = '>: ';
export const CLI_EOL = '\r\n';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Default CDC chunk size, matches FlipperStorage.chunk_size. */
export const DEFAULT_CHUNK_SIZE = 8192;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SerialError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'SerialError';
        this.fatal = Boolean(options.fatal);
    }
}

/** Find `needle` inside `haystack` starting at `from`. */
function indexOfBytes(haystack, needle, from = 0) {
    if (needle.length === 0) return from;
    outer: for (let i = from; i <= haystack.length - needle.length; i += 1) {
        for (let j = 0; j < needle.length; j += 1) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

export class FlipperSerial {
    #port = null;
    #reader = null;
    #writer = null;
    #buffer = new Uint8Array(0);
    #cursor = 0;
    #closed = false;
    #pumpPromise = null;
    #log;

    constructor(options = {}) {
        this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
        this.#log = options.log ?? (() => {});
    }

    /** Does this browser support WebSerial? */
    static isSupported() {
        return typeof navigator !== 'undefined' && 'serial' in navigator;
    }

    /** Ask the user to pick a Flipper (browser shows a native device picker). */
    static async requestPort() {
        if (!FlipperSerial.isSupported()) {
            throw new SerialError(
                'WebSerial is not available in this browser. Use desktop Chrome, Edge or ' +
                    'Opera (Firefox and Safari do not support it yet).'
            );
        }
        // The Web Serial API expects `usbVendorId`/`usbProductId` keys. 0x0483 is
        // STMicroelectronics, which covers the Flipper's CDC port and DFU mode.
        try {
            return await navigator.serial.requestPort({
                filters: [{ usbVendorId: FLIPPER_USB.vendorId }],
            });
        } catch (error) {
            if (error?.name === 'TypeError') {
                // Filter rejected (older/stricter browser build): fall back to
                // the unfiltered picker so the user can still select the device.
                return navigator.serial.requestPort();
            }
            if (error?.name === 'NotFoundError') {
                throw new SerialError('No device was selected.');
            }
            throw error;
        }
    }

    get isOpen() {
        return this.#port !== null && this.#reader !== null && !this.#closed;
    }

    get isDisconnected() {
        return this.#closed;
    }

    /** USB ids of the currently selected port, to detect DFU mode / wrong device. */
    get portInfo() {
        return this.#port?.getInfo?.() ?? {};
    }

    /** Open a previously selected port and wait for the CLI handshake. */
    async open(port) {
        this.#port = port;
        try {
            try {
                await this.#port.open({ baudRate: 115200, bufferSize: 64 * 1024 });
            } catch {
                // Browsers without `bufferSize` support still need the port open call.
                await this.#port.open({ baudRate: 115200 });
            }
        } catch (error) {
            this.#port = null;
            throw new SerialError(`Could not open the serial port: ${error.message}`, { fatal: true });
        }

        this.#buffer = new Uint8Array(0);
        this.#cursor = 0;
        this.#closed = false;
        this.#reader = this.#port.readable.getReader();
        this.#writer = this.#port.writable.getWriter();
        this.#pumpPromise = this.#pump();

        const info = this.portInfo;
        if (info.usbProductId === FLIPPER_USB.productDfu) {
            await this.close();
            throw new SerialError(
                'This Flipper is in DFU/recovery mode. Reboot it (unplug and plug the cable ' +
                    'back in without holding any buttons) and connect again.',
                { fatal: true }
            );
        }
        return info;
    }

    /** Release the port and all pending readers/writers. */
    async close() {
        this.#closed = true;
        try {
            await this.#reader?.cancel();
        } catch {
            /* already gone */
        }
        try {
            this.#reader?.releaseLock();
        } catch {
            /* already gone */
        }
        try {
            await this.#writer?.close();
        } catch {
            /* already gone */
        }
        try {
            this.#writer?.releaseLock();
        } catch {
            /* already gone */
        }
        this.#reader = null;
        this.#writer = null;
        try {
            await this.#port?.close();
        } catch {
            /* already closed/disconnected */
        }
        this.#port = null;
    }

    async #pump() {
        while (this.#reader) {
            let result;
            try {
                result = await this.#reader.read();
            } catch {
                break; // port closed or device unplugged
            }
            if (result.done) break;
            if (result.value?.byteLength) this.#append(result.value);
        }
        this.#closed = true;
    }

    #append(chunk) {
        const next = new Uint8Array(this.#buffer.length + chunk.length);
        next.set(this.#buffer, 0);
        next.set(chunk, this.#buffer.length);
        this.#buffer = next;
    }

    /** Drop everything already consumed so the buffer does not grow forever. */
    #compact() {
        if (this.#cursor === this.#buffer.length) {
            this.#buffer = new Uint8Array(0);
            this.#cursor = 0;
        } else if (this.#cursor > 32 * 1024) {
            this.#buffer = this.#buffer.slice(this.#cursor);
            this.#cursor = 0;
        }
    }

    /**
     * Read until `pattern` shows up, returning everything read before it.
     * A `timeoutMs` of 0 disables the timeout (used while flashing).
     */
    async readUntil(pattern, timeoutMs = 10000) {
        const needle = typeof pattern === 'string' ? textEncoder.encode(pattern) : pattern;
        const started = Date.now();
        for (;;) {
            const index = indexOfBytes(this.#buffer, needle, this.#cursor);
            if (index >= 0) {
                const text = textDecoder.decode(this.#buffer.subarray(this.#cursor, index));
                this.#cursor = index + needle.length;
                this.#compact();
                return text;
            }
            if (this.#closed) {
                throw new SerialError('The device was disconnected.', { fatal: true });
            }
            if (timeoutMs > 0 && Date.now() - started > timeoutMs) {
                const label = typeof pattern === 'string' ? pattern : 'the expected data';
                throw new SerialError(
                    `Timed out after ${timeoutMs} ms waiting for "${label.trim()}".`
                );
            }
            await sleep(4);
        }
    }

    /** Everything currently unread (debug helper). */
    read() {
        const text = textDecoder.decode(this.#buffer.subarray(this.#cursor));
        this.#cursor = this.#buffer.length;
        this.#compact();
        return text;
    }

    /**
     * Like readUntil(), but waits for whichever of several patterns shows up
     * first (the winner is the one that appears earliest in the stream). Only
     * one consumer is involved, so parallel readers cannot corrupt the buffer.
     * Returns `{ text, matched }`.
     */
    async readUntilAny(patterns, timeoutMs = 10000) {
        const needles = patterns.map((pattern) =>
            typeof pattern === 'string' ? textEncoder.encode(pattern) : pattern
        );
        const started = Date.now();
        for (;;) {
            let bestIndex = -1;
            let bestNeedle = -1;
            for (let i = 0; i < needles.length; i += 1) {
                const index = indexOfBytes(this.#buffer, needles[i], this.#cursor);
                if (index >= 0 && (bestIndex < 0 || index < bestIndex)) {
                    bestIndex = index;
                    bestNeedle = i;
                }
            }
            if (bestIndex >= 0) {
                const text = textDecoder.decode(this.#buffer.subarray(this.#cursor, bestIndex));
                this.#cursor = bestIndex + needles[bestNeedle].length;
                this.#compact();
                return { text, matched: patterns[bestNeedle] };
            }
            if (this.#closed) {
                throw new SerialError('The device was disconnected.', { fatal: true });
            }
            if (timeoutMs > 0 && Date.now() - started > timeoutMs) {
                throw new SerialError(
                    `Timed out after ${timeoutMs} ms waiting for ${patterns.join(' / ')}.`
                );
            }
            await sleep(4);
        }
    }

    #write(text) {
        if (!this.#writer) throw new SerialError('Serial port is not open.', { fatal: true });
        return this.#writer.write(textEncoder.encode(text));
    }

    #writeBytes(bytes) {
        if (!this.#writer) throw new SerialError('Serial port is not open.', { fatal: true });
        return this.#writer.write(bytes);
    }

    /**
     * Handshake with the CLI and return parsed device info.
     * Mirrors FlipperStorage.start(): drain the banner, then run `device_info`.
     */
    async connect(port) {
        await this.open(port);
        await sleep(600);
        // Consume the banner/prompt that the CLI prints when a terminal attaches.
        try {
            await this.readUntil(CLI_PROMPT, 6000);
        } catch {
            this.#log('CLI prompt not seen, continuing anyway...');
        }
        const info = await this.command('device_info', 8000);
        this.#log('Device info received.');
        return parseDeviceInfo(info);
    }

    /** Run one CLI command and return everything up to the next prompt. */
    async command(line, timeoutMs = 10000) {
        this.#log(`> ${line}`);
        await this.#write(`${line}\r`);
        const out = await this.readUntil(CLI_PROMPT, timeoutMs);
        if (out.includes('Storage error:')) {
            throw new SerialError(out.trim().split('\r\n')[0]);
        }
        return out;
    }

    /** `storage stat` -> true when the path exists (file or directory). */
    async exists(path) {
        await this.#write(`storage stat "${path}"\r`);
        const line = await this.readUntil(CLI_EOL, 10000);
        const rest = await this.readUntil(CLI_PROMPT, 10000);
        const text = `${line}\r\n${rest}`;
        if (text.includes('not exist') || text.includes('invalid name')) return false;
        if (text.includes('Storage error:')) {
            throw new SerialError(text.trim().split('\r\n')[0]);
        }
        return true;
    }

    /** Free space in bytes for a mount point (`/ext`). */
    async freeSpace(path = '/ext') {
        await this.#write(`storage stat "${path}"\r`);
        const line = await this.readUntil(CLI_EOL, 10000);
        await this.readUntil(CLI_PROMPT, 10000);
        // "Storage, 30528KiB total, 30528KiB free"
        const match = /(\d+)\s*KiB free/i.exec(line);
        if (!match) {
            throw new SerialError(
                'The SD card could not be read. Insert a FAT32 formatted card and try again.'
            );
        }
        return Number(match[1]) * 1024;
    }

    /** Create a directory (`storage mkdir`). Errors are surfaced to the caller. */
    async mkdir(path) {
        await this.command(`storage mkdir "${path}"`);
    }

    /** Create a directory and all of its parents. */
    async mkdirp(path) {
        const parts = path.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current += `/${part}`;
            if (await this.exists(current)) continue;
            await this.mkdir(current);
        }
    }

    /** Remove a file or directory tree. */
    async remove(path) {
        await this.command(`storage remove "${path}"`, 30000);
    }

    /**
     * Upload a file to the SD card, chunk by chunk.
     * This is the browser equivalent of FlipperStorage.send_file():
     *   `storage write_chunk "<path>" <size>`  -> "Ready"
     *   <size raw bytes>                       -> prompt
     */
    async writeFile(path, bytes, onProgress = () => {}) {
        if (await this.exists(path)) await this.remove(path);

        let sent = 0;
        const total = bytes.length;
        while (sent < total) {
            const chunk = bytes.subarray(sent, Math.min(sent + this.chunkSize, total));
            await this.#write(`storage write_chunk "${path}" ${chunk.length}\r`);
            const answer = await this.readUntil(CLI_EOL, 15000);
            if (!answer.includes('Ready')) {
                const rest = await this.readUntil(CLI_PROMPT, 15000);
                throw new SerialError(
                    `Could not write "${path}": ${(answer + rest).trim().split('\r\n')[0]}`
                );
            }
            await this.#writeBytes(chunk);
            await this.readUntil(CLI_PROMPT, 0);
            sent += chunk.length;
            onProgress(sent, total);
        }
    }

    /**
     * Ask the device to verify and apply the update.
     *
     * The CLI answers with "Verifying update package at ..." and then either
     * "Error: ..." or "OK." + "Restarting to apply update. BRB" before rebooting
     * (applications/system/updater/cli/updater_cli.c), so there is usually no
     * final prompt: wait for the verdict or for the device to disappear.
     */
    async applyUpdate(manifestPath) {
        this.#log(`> update install ${manifestPath}`);
        await this.#write(`update install ${manifestPath}\r`);

        let outcome = 'timeout';
        let tail = '';
        try {
            const verdict = await this.readUntilAny(['OK.', 'Error'], 20000);
            outcome = verdict.matched === 'OK.' ? 'ok' : 'error';
            tail = verdict.text;
        } catch {
            outcome = this.#closed ? 'rebooted' : 'timeout';
        }

        // Drain whatever the device printed after the verdict so the next
        // command starts from a clean buffer. There is no prompt after
        // `update install` - the device reboots instead - so just give it a
        // moment to finish its sentence and swallow the rest.
        await sleep(outcome === 'timeout' ? 400 : 120);
        tail += this.read();
        return [outcome, tail.trim()].filter(Boolean).join('\r\n');
    }

    /** Wait until the device disappears from the USB bus (after the reboot). */
    async waitForReboot(timeoutMs = 45000) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            if (this.#closed) return true;
            await sleep(250);
        }
        return false;
    }
}

/** Parse the `device_info` CLI output into a plain object. */
export function parseDeviceInfo(text) {
    const value = (key) => {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = new RegExp(`^\\s*${escaped}:\\s*(.*)$`, 'm').exec(text);
        return match ? match[1].trim() : null;
    };
    const numeric = (key) => {
        const raw = value(key);
        if (raw === null) return null;
        const parsed = Number.parseInt(raw, 10);
        return Number.isFinite(parsed) ? parsed : null;
    };

    return {
        model: value('hardware.model'),
        hardwareTarget: numeric('hardware.target'),
        uid: value('hardware.uid'),
        firmwareVersion: value('firmware.version'),
        firmwareTarget: numeric('firmware.target'),
        firmwareBranch: value('firmware.branch.name') ?? value('firmware.branch.num'),
        firmwareOrigin: value('firmware.origin.fork'),
        firmwareGit: value('firmware.origin.git'),
        buildDate: value('build.date'),
        api: value('firmware.api.major')
            ? `${value('firmware.api.major')}.${value('firmware.api.minor')}`
            : null,
        region: value('hardware.region'),
        raw: text,
    };
}
