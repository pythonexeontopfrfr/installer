/**
 * Integration test for assets/serial.js + assets/installer.js.
 *
 * A fake Flipper Zero CLI is mounted behind a WebSerial-shaped port, so the whole
 * install flow can be exercised without hardware:
 *   handshake -> device_info -> stat/mkdir -> chunked upload -> update install
 *
 * Run with:  node tests/serial.test.mjs
 */

import assert from 'node:assert/strict';

import { extractUpdatePackage } from '../assets/archive.js';
import { FlipperSerial, parseDeviceInfo } from '../assets/serial.js';
import { installUpdatePackage } from '../assets/installer.js';
import { gzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Quote-aware splitter: `storage stat "/ext/update"` -> ['storage','stat','/ext/update'] */
function tokenize(line) {
    return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]);
}

const DEVICE_INFO = [
    'device info:',
    'format.major: 3',
    'device.info.major: 2',
    'hardware.model: Flipper Zero',
    'hardware.uid: 1234567890ABCDEF',
    'hardware.ver: 12',
    'hardware.target: 7',
    'hardware.body: 0',
    'build.date: 16-09-2026',
    'firmware.version: 0.103.1',
    'firmware.branch.name: slowed-001',
    'firmware.target: 7',
    'firmware.api.major: 87',
    'firmware.api.minor: 0',
    'firmware.origin.fork: slowed.lol',
    'firmware.origin.git: https://github.com/example/slowed.lol',
    '',
].join('\r\n');

/** Byte-accurate model of the Flipper CLI as used by the installer. */
class FakeFlipperCli {
    constructor() {
        this.dirs = new Set(['/ext', '/ext/update']);
        this.files = new Map();
        this.out = [];
        this.waiters = [];
        this.line = '';
        this.pendingWrite = null;
        this.writtenBytes = 0;
        this.rebooted = false;
    }

    push(text) {
        this.out.push(encoder.encode(text));
        for (const waiter of this.waiters.splice(0)) waiter();
    }

    nextChunk() {
        if (this.out.length > 0) return this.out.shift();
        return null;
    }

    /** Bytes coming from the browser. */
    receive(bytes) {
        for (const byte of bytes) {
            if (this.pendingWrite) {
                this.pendingWrite.chunks.push(byte);
                this.pendingWrite.remaining -= 1;
                this.writtenBytes += 1;
                if (this.pendingWrite.remaining === 0) {
                    const { path, chunks } = this.pendingWrite;
                    const previous = this.files.get(path) ?? new Uint8Array(0);
                    const merged = new Uint8Array(previous.length + chunks.length);
                    merged.set(previous);
                    merged.set(Uint8Array.from(chunks), previous.length);
                    this.files.set(path, merged);
                    this.pendingWrite = null;
                    this.push('>: ');
                }
                continue;
            }
            if (byte === 0x0d) {
                const command = this.line;
                this.line = '';
                if (command.length > 0) this.command(command);
                continue;
            }
            if (byte === 0x0a) continue;
            this.line += String.fromCharCode(byte);
        }
    }

    command(line) {
        this.push(`${line}\r\n\r\n`);
        const args = tokenize(line);
        const name = args[0];

        if (line.startsWith('device_info')) return this.push(`${DEVICE_INFO}\r\n>: `);
        if (line === 'uptime') return this.push('uptime: 42s\r\n>: ');

        if (name === 'storage') {
            const sub = args[1];
            const target = args[2] ?? '';
            if (sub === 'stat') return this.stat(target);
            if (sub === 'mkdir') {
                this.dirs.add(target);
                return this.push('>: ');
            }
            if (sub === 'remove') {
                this.dirs.delete(target);
                for (const key of [...this.files.keys()]) {
                    if (key === target || key.startsWith(`${target}/`)) this.files.delete(key);
                }
                return this.push('>: ');
            }
            if (sub === 'write_chunk') {
                const size = Number.parseInt(args[3], 10);
                this.push('Ready\r\n');
                // The firmware opens the file with FSOM_OPEN_APPEND, so every
                // chunk is appended to what is already on the card.
                this.pendingWrite = { path: target, remaining: size, chunks: [] };
                return undefined;
            }
        }

        if (name === 'update' && args[1] === 'install') {
            const manifest = args[2];
            if (!this.files.has(manifest)) {
                return this.push('Storage error: file/dir not exist\r\n>: ');
            }
            this.push(
                `Verifying update package at '${manifest}'\r\n` +
                    'OK.\r\nRestarting to apply update. BRB\r\n'
            );
            this.rebooted = true;
            return undefined;
        }

        return this.push(`Unknown command: ${line}\r\n>: `);
    }

    stat(path) {
        if (path === '/ext') return this.push('Storage, 30528KiB total, 20000KiB free\r\n>: ');
        if (this.dirs.has(path)) return this.push('Directory\r\n>: ');
        if (this.files.has(path)) {
            return this.push(`File, size: ${this.files.get(path).length}b\r\n>: `);
        }
        return this.push('Storage error: file/dir not exist\r\n>: ');
    }
}

/** WebSerial-shaped port on top of the model above. */
class FakePort {
    constructor(device) {
        this.device = device;
        this.closed = false;
        this.opened = false;
    }

    getInfo() {
        return { usbVendorId: 0x0483, usbProductId: 0x5740 };
    }

    async open() {
        this.opened = true;
        // The CLI prints a small banner and a prompt when a terminal attaches.
        this.device.push('Welcome to the Flipper Zero CLI\r\n>: ');
    }

    async close() {
        this.closed = true;
        for (const waiter of this.device.waiters.splice(0)) waiter();
        this.device.push(''); // wake the reader so it can report `done`
    }

    get readable() {
        const device = this.device;
        const port = this;
        return {
            getReader: () => ({
                read: () =>
                    new Promise((resolve) => {
                        const deliver = () => {
                            const chunk = device.nextChunk();
                            if (chunk) return resolve({ value: chunk, done: false });
                            if (port.closed) return resolve({ value: undefined, done: true });
                            device.waiters.push(deliver);
                        };
                        deliver();
                    }),
                cancel: async () => {},
                releaseLock: () => {},
            }),
        };
    }

    get writable() {
        const device = this.device;
        return {
            getWriter: () => ({
                write: async (bytes) => {
                    device.receive(bytes);
                    await new Promise((resolve) => setTimeout(resolve, 0));
                },
                close: async () => {},
                releaseLock: () => {},
            }),
        };
    }
}

/** Build the same archive shape as tests/archive.test.mjs. */
function samplePackage() {
    const block = 512;
    const chunks = [];
    const addEntry = (name, data) => {
        const header = new Uint8Array(block);
        const put = (offset, text) => header.set(encoder.encode(text), offset);
        put(0, name);
        put(100, '0000644\0');
        put(108, '0000000\0');
        put(116, '0000000\0');
        put(124, `${data.length.toString(8).padStart(11, '0')}\0`);
        put(136, '00000000000\0');
        header.fill(0x20, 148, 156);
        put(156, '0');
        put(257, 'ustar\0');
        put(263, '00');
        put(265, 'furippa');
        put(297, 'furippa');
        let sum = 0;
        for (const byte of header) sum += byte;
        put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
        const padded = new Uint8Array(Math.ceil(data.length / block) * block);
        padded.set(data);
        chunks.push(header, padded);
    };

    const files = {
        'update.fuf': encoder.encode(
            'Filetype: Flipper firmware upgrade configuration\nVersion: 2\nTarget: 7\nFirmware: firmware.dfu\n'
        ),
        'updater.bin': new Uint8Array(1500).map((_, index) => index % 251),
        'firmware.dfu': new Uint8Array(9000).map((_, index) => (index * 7) % 253),
    };
    for (const [name, data] of Object.entries(files)) {
        addEntry(`f7-update-slowed/${name}`, data);
    }
    chunks.push(new Uint8Array(block * 2));
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const tar = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        tar.set(chunk, offset);
        offset += chunk.length;
    }
    return { tgz: gzipSync(tar), expected: files };
}

let failures = 0;
const test = async (name, fn) => {
    try {
        await fn();
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures += 1;
        console.error(`  FAIL ${name}\n       ${error.stack ?? error.message}`);
    }
};

const fixture = join(here, 'fixtures', 'sample-update.tgz');
const buildPackage = () =>
    existsSync(fixture) ? new Uint8Array(readFileSync(fixture)) : samplePackage().tgz;

const device = new FakeFlipperCli();
const port = new FakePort(device);
const serial = new FlipperSerial({ chunkSize: 1024, log: () => {} });

await test('connect() performs the CLI handshake and parses device_info', async () => {
    const info = await serial.connect(port);
    assert.equal(info.model, 'Flipper Zero');
    assert.equal(info.firmwareVersion, '0.103.1');
    assert.equal(info.firmwareTarget, 7);
    assert.equal(info.firmwareBranch, 'slowed-001');
    assert.equal(info.firmwareOrigin, 'slowed.lol');
    assert.equal(info.api, '87.0');
    assert.equal(info.buildDate, '16-09-2026');

    const parsed = parseDeviceInfo('firmware.target: 18\r\nhardware.model: X');
    assert.equal(parsed.firmwareTarget, 18);
});

await test('exists()/mkdirp() create nested folders', async () => {
    assert.equal(await serial.exists('/ext/update'), true);
    assert.equal(await serial.exists('/ext/missing'), false);
    await serial.mkdirp('/ext/update/slowed-test');
    assert.equal(device.dirs.has('/ext/update/slowed-test'), true);
    await serial.remove('/ext/update/slowed-test');
    assert.equal(device.dirs.has('/ext/update/slowed-test'), false);
});

await test('writeFile() streams binary data chunk by chunk', async () => {
    const payload = new Uint8Array(3 * 1024 + 512).map((_, index) => (index * 13) % 256);
    const progress = [];
    await serial.writeFile('/ext/blob.bin', payload, (sent, total) => progress.push(sent / total));

    assert.deepEqual(device.files.get('/ext/blob.bin'), payload, 'bytes must round-trip');
    assert.ok(progress.length >= 4, 'a 3.5 KiB file with 1 KiB chunks needs several chunks');
    assert.equal(progress.at(-1), 1);
});

await test('installUpdatePackage() uploads every file and triggers the update', async () => {
    const logs = [];
    const steps = [];
    const packageBytes = buildPackage();
    const expected = (await extractUpdatePackage(packageBytes)).files
        .map((file) => file.path)
        .sort();

    const result = await installUpdatePackage({
        serial,
        packageBytes,
        device: { firmwareTarget: 7 },
        onLog: (message) => logs.push(message),
        onProgress: (step, ratio) => steps.push([step, ratio]),
    });

    assert.equal(result.targetDir, `/ext/update/${result.folder}`);
    assert.match(result.folder, /^f7-update-slowed/);
    const uploaded = [...device.files.keys()]
        .filter((key) => key.startsWith(`${result.targetDir}/`))
        .map((key) => key.slice(result.targetDir.length + 1))
        .sort();
    assert.deepEqual(uploaded, expected);
    assert.equal(device.rebooted, true, 'the device must receive `update install`');
    assert.equal(steps.at(-1)[0], 'apply');
    assert.equal(steps.at(-1)[1], 1);
    assert.ok(
        logs.some((line) => line.includes('rebooting')),
        'the user must be told about the reboot'
    );
});

await test('the uploaded manifest is intact after the transfer', async () => {
    const result = await installUpdatePackage({
        serial,
        packageBytes: buildPackage(),
        device: { firmwareTarget: 7 },
    });
    const manifest = decoder.decode(device.files.get(`${result.targetDir}/update.fuf`));
    assert.match(manifest, /^Filetype: Flipper firmware upgrade configuration$/m);
    assert.match(manifest, /^Target: 7$/m);
});

await test('a package for the wrong hardware target is refused', async () => {
    await assert.rejects(
        () =>
            installUpdatePackage({
                serial,
                packageBytes: buildPackage(),
                device: { firmwareTarget: 18 },
            }),
        /hardware target/i
    );
});

await test('the reboot is detected through the port disconnect', async () => {
    await port.close();
    assert.equal(await serial.waitForReboot(3000), true);
    await serial.close();
    assert.equal(serial.isOpen, false);
});

console.log(`\n${7 - failures}/7 serial tests passed`);
process.exitCode = failures === 0 ? 0 : 1;
