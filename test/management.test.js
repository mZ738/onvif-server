import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer, encoderDifferences } from '../src/onvif-server.js';
import { createLogger } from '../src/logger.js';
import { validCamera } from './helpers.js';

const logger = createLogger({ level: 'error' });

const DEVICE_NS = 'http://www.onvif.org/ver10/device/wsdl';
const MEDIA_NS = 'http://www.onvif.org/ver10/media/wsdl';

function localCamera(overrides = {}) {
    const camera = validCamera(overrides);
    delete camera.mac;
    camera.hostname = '127.0.0.1';
    camera.ports = { server: 0, rtsp: 8554, snapshot: 8580 };
    return camera;
}

async function soap(port, service, namespace, body) {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:x="${namespace}" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Body>${body}</s:Body></s:Envelope>`;
    const response = await fetch(`http://127.0.0.1:${port}/onvif/${service}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/soap+xml' },
        body: envelope,
    });
    return { status: response.status, text: await response.text() };
}

const media = (server) => server.onvif.MediaService.Media;
const device = (server) => server.onvif.DeviceService.Device;

/** A SetVideoEncoderConfiguration body as a client would send it. */
function encoderRequest(token, { width = 2880, height = 1616, framerate = 20, bitrate = 4096 } = {}) {
    return `<x:SetVideoEncoderConfiguration><x:Configuration token="${token}"><tt:Name>x</tt:Name><tt:UseCount>1</tt:UseCount>`
        + `<tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>${width}</tt:Width><tt:Height>${height}</tt:Height></tt:Resolution>`
        + `<tt:Quality>4</tt:Quality><tt:RateControl><tt:FrameRateLimit>${framerate}</tt:FrameRateLimit><tt:EncodingInterval>1</tt:EncodingInterval>`
        + `<tt:BitrateLimit>${bitrate}</tt:BitrateLimit></tt:RateControl>`
        + '<tt:Multicast><tt:Address><tt:Type>IPv4</tt:Type><tt:IPv4Address>0.0.0.0</tt:IPv4Address></tt:Address><tt:Port>0</tt:Port><tt:TTL>0</tt:TTL><tt:AutoStart>false</tt:AutoStart></tt:Multicast>'
        + '<tt:SessionTimeout>PT60S</tt:SessionTimeout></x:Configuration><x:ForcePersistence>true</x:ForcePersistence></x:SetVideoEncoderConfiguration>';
}

test('lists the encoder of every profile and finds one by token', () => {
    const server = createServer(localCamera(), logger);
    const tokens = media(server).GetVideoEncoderConfigurations().Configurations.map((c) => c.attributes.token);
    assert.deepEqual(tokens, ['encoder_hq_config_token', 'encoder_lq_config_token']);

    const { Configuration } = media(server).GetVideoEncoderConfiguration({ ConfigurationToken: 'encoder_lq_config_token' });
    assert.equal(Configuration.Resolution.Width, 640);
    assert.throws(() => media(server).GetVideoEncoderConfiguration({ ConfigurationToken: 'nope' }), (error) => Boolean(error.Fault));
});

test('encoder options offer exactly the delivered stream', () => {
    const server = createServer(localCamera(), logger);
    const { Options } = media(server).GetVideoEncoderConfigurationOptions({ ConfigurationToken: 'encoder_hq_config_token' });

    assert.deepEqual(Options.H264.ResolutionsAvailable, [{ Width: 2880, Height: 1616 }]);
    assert.deepEqual(Options.H264.FrameRateRange, { Min: 20, Max: 20 });
    assert.deepEqual(Options.QualityRange, { Min: 4, Max: 4 });
    assert.deepEqual(Options.Extension.H264.BitrateRange, { Min: 4096, Max: 4096 });

    const byProfile = media(server).GetVideoEncoderConfigurationOptions({ ProfileToken: 'sub_stream' }).Options;
    assert.deepEqual(byProfile.H264.ResolutionsAvailable, [{ Width: 640, Height: 360 }]);

    const all = media(server).GetVideoEncoderConfigurationOptions({}).Options;
    assert.equal(all.H264.ResolutionsAvailable.length, 2);
    assert.deepEqual(all.H264.FrameRateRange, { Min: 15, Max: 20 });

    assert.throws(() => media(server).GetVideoEncoderConfigurationOptions({ ProfileToken: 'nope' }), (error) => Boolean(error.Fault));
});

test('encoderDifferences ignores omitted fields and compares numbers by value', () => {
    const [profile] = createServer(localCamera(), logger).profiles;
    const current = profile.VideoEncoderConfiguration;

    assert.deepEqual(encoderDifferences({ Name: 'other', Quality: '4.0', Resolution: { Width: '2880', Height: '1616' } }, current), []);
    assert.deepEqual(encoderDifferences({ RateControl: { BitrateLimit: '8192' }, Encoding: 'H265' }, current), [
        'encoding H265 (delivered: H264)',
        'bitrate 8192 (delivered: 4096)',
    ]);
});

test('SetVideoEncoderConfiguration accepts the delivered values and refuses changes, over SOAP', async (t) => {
    const server = createServer(localCamera(), logger);
    await server.startServer();
    t.after(() => server.close());
    const { port } = server.address();

    const same = await soap(port, 'media_service', MEDIA_NS, encoderRequest('encoder_hq_config_token'));
    assert.equal(same.status, 200, same.text.slice(0, 400));
    assert.match(same.text, /SetVideoEncoderConfigurationResponse/);

    const changed = await soap(port, 'media_service', MEDIA_NS, encoderRequest('encoder_hq_config_token', { bitrate: 8000 }));
    assert.equal(changed.status, 400);
    assert.match(changed.text, /<soap:Value>ter:ConfigModify<\/soap:Value>/);
    assert.match(changed.text, /bitrate 8000/);

    const unknown = await soap(port, 'media_service', MEDIA_NS, encoderRequest('nope'));
    assert.equal(unknown.status, 400);
    assert.match(unknown.text, /ter:NoConfig/);
});

test('GetVideoEncoderConfigurationOptions serializes over SOAP', async (t) => {
    const server = createServer(localCamera(), logger);
    await server.startServer();
    t.after(() => server.close());
    const { port } = server.address();

    const response = await soap(port, 'media_service', MEDIA_NS,
        '<x:GetVideoEncoderConfigurationOptions><x:ConfigurationToken>encoder_hq_config_token</x:ConfigurationToken></x:GetVideoEncoderConfigurationOptions>');
    assert.equal(response.status, 200, response.text.slice(0, 400));
    assert.match(response.text, /ResolutionsAvailable>\s*<[^>]*Width>2880</);
    assert.match(response.text, /BitrateRange>\s*<[^>]*Min>4096</);
});

test('SetSystemDateAndTime accepts NTP and a manual time close to the host clock', () => {
    const server = createServer(localCamera(), logger);
    assert.deepEqual(device(server).SetSystemDateAndTime({ DateTimeType: 'NTP', DaylightSavings: false }), {});

    const now = new Date();
    const manual = (date) => ({
        DateTimeType: 'Manual',
        DaylightSavings: false,
        UTCDateTime: {
            Date: { Year: date.getUTCFullYear(), Month: date.getUTCMonth() + 1, Day: date.getUTCDate() },
            Time: { Hour: date.getUTCHours(), Minute: date.getUTCMinutes(), Second: date.getUTCSeconds() },
        },
    });

    assert.deepEqual(device(server).SetSystemDateAndTime(manual(now)), {});
    assert.throws(
        () => device(server).SetSystemDateAndTime(manual(new Date(now.getTime() + 3_600_000))),
        (error) => error.Fault.Code.Subcode.Value === 'ter:ActionNotSupported' && error.Fault.statusCode === 500,
    );
    assert.throws(
        () => device(server).SetSystemDateAndTime({ DateTimeType: 'Manual', DaylightSavings: false }),
        (error) => error.Fault.Code.Subcode.Subcode.Value === 'ter:InvalidDateTime' && error.Fault.statusCode === 400,
    );
});

test('SetNTP is reported back by GetNTP, over SOAP', async (t) => {
    const server = createServer(localCamera(), logger);
    await server.startServer();
    t.after(() => server.close());
    const { port } = server.address();

    const before = await soap(port, 'device_service', DEVICE_NS, '<x:GetNTP/>');
    assert.equal(before.status, 200, before.text.slice(0, 400));
    assert.match(before.text, /FromDHCP>false</);

    const set = await soap(port, 'device_service', DEVICE_NS,
        '<x:SetNTP><x:FromDHCP>false</x:FromDHCP><x:NTPManual><tt:Type>IPv4</tt:Type><tt:IPv4Address>192.0.2.1</tt:IPv4Address></x:NTPManual></x:SetNTP>');
    assert.equal(set.status, 200, set.text.slice(0, 400));

    const after = await soap(port, 'device_service', DEVICE_NS, '<x:GetNTP/>');
    assert.match(after.text, /IPv4Address>192\.0\.2\.1</);
});
