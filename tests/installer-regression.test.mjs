import assert from 'node:assert/strict';
import { FlipperSerial, parseDeviceInfo } from '../assets/serial.js';
import { findUpdateAsset, installUpdatePackage } from '../assets/installer.js';
import { readFileSync } from 'node:fs';

// Firmware-format fixtures, not a capture from a connected device.
const padded = [
    'device_info',
    'hardware_model                : Flipper Zero',
    'hardware_target               : 7',
    'firmware_target               : 7',
    'firmware_version              : 1.4.3',
    'firmware_origin_fork          : slowed.lol',
].join('\r\n');
const parsed = parseDeviceInfo(padded);
assert.equal(parsed.firmwareTarget, 7);
assert.equal(parsed.hardwareTarget, 7);
assert.equal(parsed.firmwareVersion, '1.4.3');
assert.equal(parsed.firmwareOrigin, 'slowed.lol');
assert.equal(parseDeviceInfo('firmware.target   : 18\r\n').firmwareTarget, 18);
assert.equal(parseDeviceInfo('unknown output').firmwareTarget, null);
console.log('ok: padded underscore and dotted device-info keys');

const serial = new FlipperSerial();
for (const response of [
    'Storage, 30528KiB total, 20000KiB free\r\n',
    'storage stat "/ext"\r\n\r\nStorage, 30528KiB total, 20000KiB free\r\n',
    'Label: SD\r\n30528KiB total\r\n20000KiB free\r\n',
]) {
    serial.command = async (line) => {
        assert.equal(line, 'storage stat "/ext"');
        return response;
    };
    assert.equal(await serial.freeSpace(), 20000 * 1024);
}
serial.command = async () => 'unexpected response';
await assert.rejects(() => serial.freeSpace(), /Device response: unexpected response/);
console.log('ok: free space with echoes, blank lines, and multiline replies');

const release = { assets: [
    { name: 'flipper-z-f18-update-test.tgz' },
    { name: 'flipper-z-f7-update-test.tgz' },
] };
assert.equal(findUpdateAsset(release, parsed.firmwareTarget).name, 'flipper-z-f7-update-test.tgz');
const packageBytes = new Uint8Array(readFileSync(new URL('./fixtures/sample-update.tgz', import.meta.url)));
for (const device of [null, {}, { firmwareTarget: 99 }]) {
    await assert.rejects(() => installUpdatePackage({ serial: {}, device, packageBytes }), /Hardware target is unknown/);
}
await assert.rejects(() => installUpdatePackage({ serial: {}, device: { firmwareTarget: 18 }, packageBytes }), /does not match/);
console.log('ok: f7 asset selected; unknown and mismatched targets stop before storage access');
