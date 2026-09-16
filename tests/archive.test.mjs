/**
 * Tests for assets/archive.js — the gzip + USTAR handling used by the installer.
 *
 * Run with:  node tests/archive.test.mjs
 * Optional:  node tests/archive.test.mjs path/to/flipper-z-f7-update-*.tgz
 *            (validates a real package produced by `fbt updater_package`)
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import {
    extractUpdatePackage,
    isGzipped,
    parseTar,
    supportsDecompressionStream,
} from '../assets/archive.js';

const BLOCK = 512;
const encoder = new TextEncoder();
const paddedLength = (size) => Math.ceil(size / BLOCK) * BLOCK;

/** Write one USTAR header block (same layout as python's tarfile.USTAR_FORMAT). */
function header(name, size, type) {
    const block = new Uint8Array(BLOCK);
    const put = (offset, length, text) => {
        block.set(encoder.encode(text).subarray(0, length), offset);
    };

    put(0, 100, name);
    put(100, 8, '0000644\0'); // mode
    put(108, 8, '0000000\0'); // uid
    put(116, 8, '0000000\0'); // gid
    put(124, 12, `${size.toString(8).padStart(11, '0')}\0`); // size
    put(136, 12, '00000000000\0'); // mtime
    block.fill(0x20, 148, 156); // checksum placeholder
    put(156, 1, type); // typeflag
    put(257, 6, 'ustar\0'); // magic
    put(263, 2, '00'); // version
    put(265, 32, 'furippa'); // uname
    put(297, 32, 'furippa'); // gname

    let sum = 0;
    for (const byte of block) sum += byte;
    block.set(encoder.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
    return block;
}

/** Build an uncompressed USTAR archive from `[{ path, bytes, directory }]`. */
function buildTar(entries) {
    const chunks = [];
    for (const entry of entries) {
        const bytes = entry.bytes ?? new Uint8Array(0);
        chunks.push(header(entry.path, bytes.length, entry.directory ? '5' : '0'));
        if (bytes.length > 0) {
            const padded = new Uint8Array(paddedLength(bytes.length));
            padded.set(bytes);
            chunks.push(padded);
        }
    }
    chunks.push(new Uint8Array(BLOCK * 2)); // two zero blocks end the archive

    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

/** A miniature update package, same shape as the real one. */
function sampleBundle() {
    const dir = 'f7-update-slowed';
    return [
        { path: `${dir}/`, bytes: new Uint8Array(0), directory: true },
        {
            path: `${dir}/update.fuf`,
            bytes: encoder.encode(
                'Filetype: Flipper firmware upgrade configuration\n' +
                    'Version: 2\n' +
                    'Info: slowed-001\n' +
                    'Target: 7\n' +
                    'Loader: updater.bin\n'
            ),
        },
        { path: `${dir}/updater.bin`, bytes: new Uint8Array(1024).fill(0xaa) },
        { path: `${dir}/firmware.dfu`, bytes: new Uint8Array(4096).fill(0x5a) },
    ];
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('isGzipped detects the gzip magic and rejects plain buffers', () => {
    const tar = buildTar(sampleBundle());
    assert.equal(isGzipped(tar), false);
    assert.equal(isGzipped(gzipSync(tar)), true);
    assert.equal(isGzipped(new Uint8Array(0)), false);
});

test('DecompressionStream is available in this runtime', () => {
    assert.equal(supportsDecompressionStream(), true);
});

test('parseTar reads file contents and sizes, and keeps directory entries', () => {
    const { entries } = parseTar(buildTar(sampleBundle()));

    assert.deepEqual(
        entries.map((entry) => entry.path),
        [
            'f7-update-slowed', // trailing slash is normalised away by the parser
            'f7-update-slowed/update.fuf',
            'f7-update-slowed/updater.bin',
            'f7-update-slowed/firmware.dfu',
        ]
    );
    assert.equal(entries[0].directory, true);

    const updater = entries.find((entry) => entry.path.endsWith('updater.bin'));
    assert.equal(updater.size, 1024);
    assert.equal(updater.bytes.length, 1024);
    assert.equal(updater.bytes[0], 0xaa);

    assert.equal(entries.find((entry) => entry.path.endsWith('firmware.dfu')).bytes.length, 4096);
});

test('parseTar handles a payload whose size is not block aligned', () => {
    const payload = encoder.encode('slowed');
    const { entries } = parseTar(buildTar([{ path: 'short.txt', bytes: payload }]));
    assert.equal(entries.length, 1);
    assert.equal(new TextDecoder().decode(entries[0].bytes), 'slowed');

    const parsed = parseTar(
        buildTar([
            { path: 'a.txt', bytes: payload },
            { path: 'b.txt', bytes: encoder.encode('next') },
        ])
    ).entries;
    assert.deepEqual(
        parsed.map((entry) => entry.path),
        ['a.txt', 'b.txt']
    );
});

test('parseTar rejects a corrupted archive instead of trusting it', () => {
    const tar = new Uint8Array(buildTar(sampleBundle()));
    tar[300] ^= 0xff; // stomp on header data, breaking the checksum
    assert.throws(() => parseTar(tar), /bad header checksum|does not contain any files/);
});

test('extractUpdatePackage returns the layout the installer needs', async () => {
    const bundle = await extractUpdatePackage(gzipSync(buildTar(sampleBundle())));

    assert.equal(bundle.rootDir, 'f7-update-slowed');
    assert.deepEqual(
        bundle.files.map((file) => file.path).sort(),
        ['firmware.dfu', 'update.fuf', 'updater.bin']
    );
    assert.equal(bundle.manifest.path, 'update.fuf');
    assert.match(new TextDecoder().decode(bundle.manifest.bytes), /Target: 7/);
    assert.equal(bundle.totalSize, 1024 + 4096 + bundle.manifest.size);
});

test('extractUpdatePackage also accepts an uncompressed tar', async () => {
    const bundle = await extractUpdatePackage(buildTar(sampleBundle()));
    assert.equal(bundle.rootDir, 'f7-update-slowed');
    assert.equal(bundle.files.length, 3);
});

test('extractUpdatePackage refuses archives without update.fuf', async () => {
    const tar = buildTar([{ path: 'readme.txt', bytes: encoder.encode('nope') }]);
    await assert.rejects(() => extractUpdatePackage(gzipSync(tar)), /not a Flipper update package/);
});

let failures = 0;
for (const [name, fn] of tests) {
    try {
        await fn();
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures += 1;
        console.error(`  FAIL ${name}\n       ${error.message}`);
    }
}

// Optional: validate a real package passed on the command line.
const realPackage = process.argv[2];
if (realPackage) {
    const bytes = new Uint8Array(readFileSync(realPackage));
    const bundle = await extractUpdatePackage(bytes);
    console.log(`\nReal package: ${realPackage}`);
    console.log(`  bundle    ${bundle.rootDir}`);
    console.log(`  files     ${bundle.files.map((file) => file.path).join(', ')}`);
    console.log(`  unpacked  ${(bundle.totalSize / (1024 * 1024)).toFixed(2)} MiB`);
    console.log(
        `  manifest  ${new TextDecoder()
            .decode(bundle.manifest.bytes)
            .trim()
            .replace(/\r?\n/g, ' | ')}`
    );
    assert.ok(bundle.manifest, 'a real package must contain update.fuf');
}

console.log(`\n${tests.length - failures}/${tests.length} tests passed`);
// exitCode instead of exit() so that piped stdout is not truncated.
process.exitCode = failures === 0 ? 0 : 1;

