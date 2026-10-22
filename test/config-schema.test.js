import test from 'node:test';
import assert from 'node:assert/strict';

import { validateConfig } from '../src/config-schema.js';
import { validCamera, validConfig } from './helpers.js';

test('accepts a well-formed config', () => {
    assert.deepEqual(validateConfig(validConfig()), []);
});

test('accepts a camera with hostname instead of mac', () => {
    const camera = validCamera();
    delete camera.mac;
    camera.hostname = '10.0.0.5';
    assert.deepEqual(validateConfig(validConfig([camera])), []);
});

test('accepts a camera with no lowQuality stream', () => {
    const camera = validCamera();
    delete camera.lowQuality;
    assert.deepEqual(validateConfig(validConfig([camera])), []);
});

test('rejects a non-mapping top level', () => {
    assert.deepEqual(validateConfig('nope'), ['config: expected a mapping at the top level']);
});

test('rejects a missing onvif list', () => {
    assert.deepEqual(validateConfig({}), ['onvif: expected a list of cameras']);
});

test('rejects an empty onvif list', () => {
    assert.deepEqual(validateConfig({ onvif: [] }), ['onvif: no cameras defined']);
});

test('rejects a malformed mac and says which camera', () => {
    const problems = validateConfig(validConfig([validCamera({ mac: 'not-a-mac' })]));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^onvif\[0\]\.mac:/);
});

test('rejects an out-of-range port', () => {
    const camera = validCamera();
    camera.ports.server = 70000;
    const problems = validateConfig(validConfig([camera]));
    assert.ok(problems.some((p) => p.startsWith('onvif[0].ports.server:')));
});

test('rejects an rtsp path that is not a path', () => {
    const camera = validCamera();
    camera.highQuality.rtsp = 'rtsp://192.0.2.10:554/stream';
    const problems = validateConfig(validConfig([camera]));
    assert.ok(problems.some((p) => p.startsWith('onvif[0].highQuality.rtsp:')));
});

test('rejects a non-numeric resolution', () => {
    const camera = validCamera();
    camera.highQuality.width = '2880';
    const problems = validateConfig(validConfig([camera]));
    assert.ok(problems.some((p) => p.startsWith('onvif[0].highQuality.width:')));
});

test('reports every problem at once rather than only the first', () => {
    const camera = validCamera({ mac: 'bad', name: '' });
    delete camera.target;
    const problems = validateConfig(validConfig([camera]));
    assert.ok(problems.length >= 3, `expected several problems, got ${problems.length}`);
});

test('catches two cameras fighting over the same port', () => {
    const a = validCamera();
    const b = validCamera({ name: 'Back Door', uuid: 'd1b2c3d4-0000-4000-8000-000000000002' });
    const problems = validateConfig(validConfig([a, b]));
    assert.ok(problems.some((p) => /already used by onvif\[0\]/.test(p)));
});

test('allows distinct cameras on distinct ports', () => {
    const a = validCamera();
    const b = validCamera({
        name: 'Back Door',
        uuid: 'd1b2c3d4-0000-4000-8000-000000000002',
        mac: 'ab:cd:ef:01:02:04',
        ports: { server: 8082, rtsp: 8555, snapshot: 8581 },
    });
    assert.deepEqual(validateConfig(validConfig([a, b])), []);
});

test('accepts motion from MQTT', () => {
    const config = validConfig([validCamera({ motion: { topic: 'frigate/front/motion', payloadOn: 'on', payloadOff: 'off', resetAfter: 60 } })]);
    config.mqtt = { url: 'mqtts://broker.example:8883', username: 'onvif', clientId: 'onvif-1' };
    assert.deepEqual(validateConfig(config), []);
});

test('motion needs a broker', () => {
    const problems = validateConfig(validConfig([validCamera({ motion: { topic: 'cam/motion' } })]));
    assert.ok(problems.some((problem) => problem.startsWith('mqtt: missing')));
});

test('rejects bad motion settings', () => {
    const config = validConfig([
        validCamera({ motion: { topic: 'cams/+/motion', payloadOn: true, resetAfter: -1 } }),
        validCamera({ uuid: 'other', mac: 'ab:cd:ef:01:02:04', motion: { topic: 'x', payloadOn: 'OFF' } }),
    ]);
    config.mqtt = { url: 'mqtt://192.0.2.10' };
    const problems = validateConfig(config);

    assert.ok(problems.some((problem) => problem.includes('onvif[0].motion.topic: wildcards')));
    assert.ok(problems.some((problem) => problem.includes('onvif[0].motion.payloadOn')));
    assert.ok(problems.some((problem) => problem.includes('onvif[0].motion.resetAfter')));
    assert.ok(problems.some((problem) => problem.includes('onvif[1].motion: payloadOn and payloadOff must differ')));
});

test('keeps MQTT credentials out of the config', () => {
    const inUrl = validConfig();
    inUrl.mqtt = { url: 'mqtt://user:pw@192.0.2.10' };
    assert.ok(validateConfig(inUrl).some((problem) => problem.includes('no credentials in the URL')));

    const asKey = validConfig();
    asKey.mqtt = { url: 'mqtt://192.0.2.10', password: 'pw' };
    assert.ok(validateConfig(asKey).some((problem) => problem.includes('MQTT_PASSWORD')));
});

test('rejects an unusable broker URL', () => {
    for (const url of ['http://192.0.2.10', 'broker:1883', undefined]) {
        const config = validConfig();
        config.mqtt = { url };
        assert.ok(validateConfig(config).some((problem) => problem.startsWith('mqtt.url')), String(url));
    }
});
