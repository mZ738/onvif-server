import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer, AUDIO_DEFAULTS } from '../src/onvif-server.js';
import { validateConfig } from '../src/config-schema.js';
import { createLogger } from '../src/logger.js';
import { validCamera, validConfig } from './helpers.js';

const logger = createLogger({ level: 'error' });

function localCamera(overrides = {}) {
    const camera = validCamera(overrides);
    delete camera.mac;
    camera.hostname = '127.0.0.1';
    camera.ports = { server: 0, rtsp: 8554, snapshot: 8580 };
    return camera;
}

const media = (server) => server.onvif.MediaService.Media;

test('without audio the profiles are unchanged and audio queries return nothing', () => {
    const server = createServer(localCamera(), logger);

    for (const profile of server.profiles) {
        assert.equal(profile.AudioSourceConfiguration, undefined);
        assert.equal(profile.AudioEncoderConfiguration, undefined);
    }
    assert.deepEqual(media(server).GetAudioSources(), { AudioSources: [] });
    assert.deepEqual(media(server).GetAudioEncoderConfigurations(), { Configurations: [] });
    assert.throws(() => media(server).GetAudioEncoderConfiguration(), (error) => Boolean(error.Fault));
});

test('audio entries sit between the video entries, as tt:Profile requires', () => {
    const server = createServer(localCamera({ audio: true }), logger);

    for (const profile of server.profiles) {
        const keys = Object.keys(profile).filter((key) => key.endsWith('Configuration'));
        assert.deepEqual(keys, [
            'VideoSourceConfiguration',
            'AudioSourceConfiguration',
            'VideoEncoderConfiguration',
            'AudioEncoderConfiguration',
        ]);
    }
});

test('audio: true advertises the defaults', () => {
    const server = createServer(localCamera({ audio: true }), logger);
    const [encoder] = media(server).GetAudioEncoderConfigurations().Configurations;

    assert.equal(encoder.Encoding, AUDIO_DEFAULTS.encoding);
    assert.equal(encoder.Bitrate, AUDIO_DEFAULTS.bitrate);
    assert.equal(encoder.SampleRate, AUDIO_DEFAULTS.samplerate);
    assert.equal(media(server).GetAudioSources().AudioSources[0].Channels, AUDIO_DEFAULTS.channels);
});

test('a mapping overrides single fields and keeps the other defaults', () => {
    const server = createServer(localCamera({ audio: { encoding: 'G711', samplerate: 8 } }), logger);
    const { Configuration } = media(server).GetAudioEncoderConfiguration();

    assert.equal(Configuration.Encoding, 'G711');
    assert.equal(Configuration.SampleRate, 8);
    assert.equal(Configuration.Bitrate, AUDIO_DEFAULTS.bitrate);
});

test('the encoder options offer exactly the delivered configuration', () => {
    const server = createServer(localCamera({ audio: { bitrate: 32 } }), logger);
    const [option] = media(server).GetAudioEncoderConfigurationOptions().Options.Options;

    assert.deepEqual(option, { Encoding: 'AAC', BitrateList: { Items: [32] }, SampleRateList: { Items: [16] } });
});

test('use counts match the number of profiles', () => {
    const camera = localCamera({ audio: true });
    delete camera.lowQuality;
    const server = createServer(camera, logger);

    assert.equal(server.profiles.length, 1);
    assert.equal(server.audioEncoderConfiguration.UseCount, 1);
    assert.equal(createServer(localCamera({ audio: true }), logger).audioEncoderConfiguration.UseCount, 2);
});

test('config validation accepts true and sane mappings', () => {
    assert.deepEqual(validateConfig(validConfig([validCamera({ audio: true })])), []);
    assert.deepEqual(validateConfig(validConfig([validCamera({ audio: { encoding: 'AAC', bitrate: 64, samplerate: 16, channels: 1 } })])), []);
});

test('config validation rejects unknown encodings and Hz instead of kHz', () => {
    const problems = validateConfig(validConfig([validCamera({ audio: { encoding: 'MP3', samplerate: 16000 } })]));

    assert.ok(problems.some((problem) => problem.includes('audio.encoding')));
    assert.ok(problems.some((problem) => problem.includes('kHz')));
});
