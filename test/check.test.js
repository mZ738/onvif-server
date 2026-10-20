import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import yaml from 'yaml';

import { checkConfig, verifyVendoredSchemas } from '../src/check.js';
import { validCamera, validConfig } from './helpers.js';

const run = promisify(execFile);
const MAIN = path.join(import.meta.dirname, '..', 'main.js');

function camera(host, overrides = {}) {
    const result = validCamera(overrides);
    delete result.mac;
    result.hostname = host;
    return result;
}

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function vendor(dir, files) {
    const sums = [];
    for (const [relative, content] of Object.entries(files)) {
        const file = path.join(dir, ...relative.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        sums.push(`${createHash('sha256').update(content).digest('hex')}  ${relative}`);
    }
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
}

test('reports devices, profiles, audio and forwarders without errors', (t) => {
    const config = validConfig([camera('192.0.2.21', { audio: true }), camera('192.0.2.22', { name: 'Back Garden', uuid: 'u2' })]);
    const { errors, report } = checkConfig(config, { vendorDir: tempDir(t) });

    assert.deepEqual(errors, []);
    const text = report.join('\n');
    assert.match(text, /Front Door/);
    assert.match(text, /MainStream: H264 2880x1616, 20 fps, 4096 kbit\/s, audio AAC 16 kHz 64 kbit\/s/);
    assert.match(text, /forwarders \(4\)/);
    assert.match(text, /192\.0\.2\.22:8554 -> 192\.0\.2\.10:554/);
});

test('an unresolvable MAC is an error', (t) => {
    const config = validConfig([validCamera({ mac: '02:00:00:00:00:99' })]);
    const { errors } = checkConfig(config, { vendorDir: tempDir(t) });
    assert.ok(errors.some((error) => error.includes('02:00:00:00:00:99')));
});

test('one address forwarding to two targets is an error', (t) => {
    const other = camera('192.0.2.21', { name: 'Other', uuid: 'u3', target: { hostname: '192.0.2.99', ports: { rtsp: 554, snapshot: 80 } } });
    const { errors } = checkConfig(validConfig([camera('192.0.2.21'), other]), { vendorDir: tempDir(t) });
    assert.ok(errors.some((error) => error.startsWith('forwarding:')));
});

test('missing vendored schemas are a warning, not an error', (t) => {
    const { errors, warnings } = checkConfig(validConfig([camera('192.0.2.21')]), { vendorDir: path.join(tempDir(t), 'none') });
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((warning) => warning.includes('internet')));
});

test('verifyVendoredSchemas detects missing and altered files', (t) => {
    const dir = tempDir(t);
    vendor(dir, { 'example.org/a.xsd': '<a/>', 'example.org/b.xsd': '<b/>' });
    assert.equal(verifyVendoredSchemas(dir).state, 'ok');

    fs.writeFileSync(path.join(dir, 'example.org', 'a.xsd'), '<changed/>');
    fs.rmSync(path.join(dir, 'example.org', 'b.xsd'));
    const result = verifyVendoredSchemas(dir);
    assert.equal(result.state, 'damaged');
    assert.deepEqual(result.problems.sort(), ['example.org/a.xsd: checksum mismatch', 'example.org/b.xsd: missing']);
});

test('--check exits 0 for a good config and 1 for a broken one, opening no port', async (t) => {
    const dir = tempDir(t);
    const good = path.join(dir, 'good.yaml');
    const bad = path.join(dir, 'bad.yaml');
    // A port that is certainly in use would make a real start fail; --check must not care.
    fs.writeFileSync(good, yaml.stringify(validConfig([camera('127.0.0.1', { ports: { server: 1, rtsp: 8554 } })])));
    fs.writeFileSync(bad, yaml.stringify({ onvif: [{ name: 'x' }] }));

    const ok = await run(process.execPath, [MAIN, '--check', good]);
    assert.match(ok.stdout, /config ok/);

    await assert.rejects(run(process.execPath, [MAIN, '-t', bad]), (error) => error.code === 1);
});
