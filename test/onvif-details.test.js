import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/onvif-server.js';
import { createLogger } from '../src/logger.js';
import { validCamera } from './helpers.js';

const logger = createLogger({ level: 'error' });

function localCamera(overrides = {}) {
    const camera = validCamera(overrides);
    delete camera.mac;
    camera.hostname = '127.0.0.1';
    camera.ports = { server: 0, rtsp: 8554, snapshot: 8580 };
    return camera;
}

async function soap(port, service, namespace, operation) {
    const body = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:x="${namespace}"><s:Body><x:${operation}/></s:Body></s:Envelope>`;
    const response = await fetch(`http://127.0.0.1:${port}/onvif/${service}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/soap+xml' },
        body,
    });
    return { status: response.status, text: await response.text() };
}

test('discovery does not announce PTZ, and announces audio only when configured', () => {
    const plain = createServer(localCamera(), logger).discoveryScopes();
    assert.ok(!plain.some((scope) => scope.includes('/type/ptz')));
    assert.ok(!plain.some((scope) => scope.includes('audio')));
    assert.ok(plain.includes('onvif://www.onvif.org/type/video_encoder'));
    // Kept unchanged so existing adoptions still match.
    assert.ok(plain.includes('onvif://www.onvif.org/name/Cardinal'));

    const withAudio = createServer(localCamera({ audio: true }), logger).discoveryScopes();
    assert.ok(withAudio.includes('onvif://www.onvif.org/type/audio_encoder'));
});

test('no relay outputs are claimed', () => {
    const { Capabilities } = createServer(localCamera(), logger).onvif.DeviceService.Device.GetCapabilities({});
    assert.equal(Capabilities.Device.IO.RelayOutputs, 0);
    assert.equal(Capabilities.Extension, undefined);
});

test('DeviceIO lists the audio source when audio is advertised', () => {
    const device = createServer(localCamera({ audio: true }), logger).onvif.DeviceService.Device;
    assert.equal(device.GetCapabilities({}).Capabilities.Extension.DeviceIO.AudioSources, 1);
    assert.equal(device.GetCapabilities({ Category: 'Media' }).Capabilities.Extension, undefined);
});

test('the video encoder carries Multicast right before SessionTimeout', () => {
    const [profile] = createServer(localCamera(), logger).profiles;
    const keys = Object.keys(profile.VideoEncoderConfiguration);
    assert.equal(keys.indexOf('Multicast') + 1, keys.indexOf('SessionTimeout'));
});

test('GetCapabilities and GetProfiles serialize over SOAP', async (t) => {
    const server = createServer(localCamera({ audio: true }), logger);
    await server.startServer();
    t.after(() => server.close());
    const { port } = server.address();

    const capabilities = await soap(port, 'device_service', 'http://www.onvif.org/ver10/device/wsdl', 'GetCapabilities');
    assert.equal(capabilities.status, 200, capabilities.text.slice(0, 300));
    assert.match(capabilities.text, /AudioSources>1</);

    const profiles = await soap(port, 'media_service', 'http://www.onvif.org/ver10/media/wsdl', 'GetProfiles');
    assert.equal(profiles.status, 200, profiles.text.slice(0, 300));
    assert.match(profiles.text, /Multicast>/);
    assert.match(profiles.text, /Encoding>AAC</);
});
