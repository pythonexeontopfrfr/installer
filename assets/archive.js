/**
 * archive.js - in-browser gzip + USTAR tar handling for Flipper Zero update packages.
 *
 * Why this file exists:
 *   `fbt updater_package` produces an update bundle and packs it as a gzipped USTAR
 *   tarball (see scripts/sconsdist.py -> tarfile.open(..., format=FLIPPER_TAR_FORMAT)
 *   with FLIPPER_TAR_FORMAT = tarfile.USTAR_FORMAT from scripts/flipper/assets/tarball.py).
 *
 *   The bundle itself contains flat files described by scripts/update.py:
 *     update.fuf    - manifest (Flipper File Format)
 *     updater.bin   - stage 2 loader executed from RAM
 *     firmware.dfu  - firmware image (DfuSe, see scripts/bin2dfu.py)
 *     radio.bin     - Core2 radio stack (optional)
 *     resources.ths - heatshrink-compressed resources tar (optional)
 *     splash.bin    - post-update slideshow (optional)
 *
 *   The Flipper's own updater consumes the directory that holds update.fuf, so the
 *   installer has to explode this archive and push every file to the SD card.
 *
 * This module is intentionally dependency-free and only uses DecompressionStream,
 * so it can be unit tested with node (see tests/archive.test.mjs).
 */

export const BLOCK_SIZE = 512;

/** Name/size offsets inside a USTAR header block. */
const OFF_NAME = 0;
const OFF_NAME_LEN = 100;
const OFF_SIZE = 124;
const OFF_SIZE_LEN = 12;
const OFF_CHECKSUM = 148;
const OFF_CHECKSUM_LEN = 8;
const OFF_TYPE = 156;
const OFF_PREFIX = 345;
const OFF_PREFIX_LEN = 155;

const textDecoder = new TextDecoder('utf-8');

/** Is the native gzip decompressor available? (Chrome/Edge 80+, Safari 16.4+, Firefox 113+) */
export function supportsDecompressionStream() {
    return typeof DecompressionStream === 'function';
}

/** Does this buffer look like a gzipped file? */
export function isGzipped(bytes) {
    return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Decode a NUL terminated USTAR field. */
function readField(bytes, offset, length) {
    let end = offset;
    const limit = offset + length;
    while (end < limit && bytes[end] !== 0) end += 1;
    return textDecoder.decode(bytes.subarray(offset, end)).replace(/\0+$/, '');
}

/** Parse a USTAR numeric field (octal, with a fallback for GNU base-256 entries). */
function readNumber(bytes, offset, length) {
    if (bytes[offset] & 0x80) {
        let value = 0;
        for (let i = offset + 1; i < offset + length; i += 1) {
            value = value * 256 + bytes[i];
        }
        return value;
    }
    const raw = readField(bytes, offset, length).trim();
    if (raw === '') return 0;
    const value = parseInt(raw, 8);
    return Number.isFinite(value) ? value : 0;
}

/** USTAR header checksum: sum of all header bytes, with the checksum field read as spaces. */
function headerChecksumValid(bytes, offset) {
    const expected = readNumber(bytes, offset + OFF_CHECKSUM, OFF_CHECKSUM_LEN);
    let sum = 0;
    for (let i = 0; i < BLOCK_SIZE; i += 1) {
        const inChecksumField = i >= OFF_CHECKSUM && i < OFF_CHECKSUM + OFF_CHECKSUM_LEN;
        sum += inChecksumField ? 0x20 : bytes[offset + i];
    }
    return expected === sum;
}

/** Is this block the (all zero) end-of-archive marker? */
function isZeroBlock(bytes, offset) {
    for (let i = offset; i < offset + BLOCK_SIZE; i += 1) {
        if (bytes[i] !== 0) return false;
    }
    return true;
}

/** Strip `./`, leading slashes and path traversal from an archive entry name. */
function normalizeEntryPath(raw) {
    const cleaned = String(raw).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    const parts = cleaned.split('/').filter((part) => part !== '' && part !== '.' && part !== '..');
    return parts.join('/');
}

/**
 * Parse an uncompressed USTAR archive.
 *
 * Returns `{ entries }` where every entry is `{ path, size, bytes, directory }`.
 * Regular files carry their data, directories carry no bytes. Link/device entries
 * and metadata (PAX/GNU) blocks are skipped.
 */
export function parseTar(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const entries = [];
    let offset = 0;
    let longName = null;

    while (offset + BLOCK_SIZE <= bytes.length) {
        if (isZeroBlock(bytes, offset)) break; // end of archive

        if (!headerChecksumValid(bytes, offset)) {
            throw new Error(
                `Corrupted tar archive: bad header checksum at offset ${offset}. ` +
                    'The downloaded file is probably an error page instead of a firmware package.'
            );
        }

        const type = String.fromCharCode(bytes[offset + OFF_TYPE] || 0x30);
        const size = readNumber(bytes, offset + OFF_SIZE, OFF_SIZE_LEN);
        const prefix = readField(bytes, offset + OFF_PREFIX, OFF_PREFIX_LEN);
        let name = readField(bytes, offset + OFF_NAME, OFF_NAME_LEN);
        if (prefix) name = `${prefix}/${name}`;

        const dataStart = offset + BLOCK_SIZE;
        const dataBlocks = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
        const nextOffset = dataStart + dataBlocks;

        if (nextOffset > bytes.length + BLOCK_SIZE) {
            throw new Error('Corrupted tar archive: file data runs past the end of the archive.');
        }

        if (type === 'L') {
            // GNU long name: the real file name lives in this entry's data
            longName = textDecoder
                .decode(bytes.subarray(dataStart, dataStart + size))
                .replace(/\0.*$/, '');
        } else if (type === 'x' || type === 'g') {
            // PAX extended headers: not produced by this toolchain, safe to skip
        } else {
            const path = normalizeEntryPath(longName || name);
            longName = null;
            if (path) {
                if (type === '5') {
                    entries.push({ path, size: 0, bytes: null, directory: true });
                } else if (type === '0' || type === '\0' || type === '7') {
                    entries.push({
                        path,
                        size,
                        bytes: bytes.subarray(dataStart, dataStart + size),
                        directory: false,
                    });
                }
            }
        }

        offset = nextOffset;
    }

    if (entries.length === 0) {
        throw new Error('The archive does not contain any files.');
    }
    return { entries };
}

/** gunzip (if needed) an ArrayBuffer/Blob/Uint8Array and return a Uint8Array. */
export async function decompressPackage(source) {
    const bytes =
        source instanceof Uint8Array
            ? source
            : source instanceof ArrayBuffer
              ? new Uint8Array(source)
              : new Uint8Array(await source.arrayBuffer());

    if (!isGzipped(bytes)) return bytes; // already a plain tar
    if (!supportsDecompressionStream()) {
        throw new Error(
            'Your browser cannot decompress .tgz files (DecompressionStream is missing). ' +
                'Please use a current version of Chrome, Edge, Safari or Firefox.'
        );
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Full pipeline: `.tgz` bytes -> the files the Flipper updater needs.
 *
 * Returns `{ rootDir, files, manifest, totalSize }`:
 *  - `rootDir`  the bundle directory name inside the archive (`f7-update-slowed`)
 *  - `files`    flat list of `{ path, bytes, size }` relative to `rootDir`
 *  - `manifest` the `update.fuf` entry (the updater entry point)
 */
export async function extractUpdatePackage(source) {
    const raw = await decompressPackage(source);
    const { entries } = parseTar(raw);
    const files = entries.filter((entry) => !entry.directory);

    const manifestEntry = files.find((entry) => /(^|\/)update\.fuf$/.test(entry.path));
    if (!manifestEntry) {
        throw new Error(
            'This archive is not a Flipper update package: no update.fuf manifest found inside.'
        );
    }

    const rootDir = manifestEntry.path.includes('/')
        ? manifestEntry.path.slice(0, manifestEntry.path.lastIndexOf('/'))
        : '';

    const scoped = files.map((entry) => ({
        path:
            rootDir && entry.path.startsWith(`${rootDir}/`)
                ? entry.path.slice(rootDir.length + 1)
                : entry.path,
        size: entry.size,
        bytes: entry.bytes,
    }));

    return {
        rootDir: rootDir || 'slowed-update',
        files: scoped,
        manifest: scoped.find((entry) => /(^|\/)update\.fuf$/.test(entry.path)),
        totalSize: scoped.reduce((sum, entry) => sum + entry.size, 0),
    };
}
