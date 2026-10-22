import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { MqttMotionInput, redactUrl } from '../src/mqtt-motion.js';
import { createLogger } from '../src/logger.js';
import { Metrics } from '../src/metrics.js';

const logger = createLogger({ level: 'error' });

/** Stands in for an mqtt.js client: records calls, lets the test emit events. */
class FakeClient extends EventEmitter {
    subscriptions = [];
    ended = false;

    subscribe(topics, options, callback) {
        this.subscriptions.push({ topics, options });
        callback?.(null);
    }

    async endAsync() {
        this.ended = true;
    }

    message(topic, text) {
        this.emit('message', topic, Buffer.from(text));
    }
}

function setup({ metrics = null } = {}) {
    const client = new FakeClient();
    let connectArgs;
    const input = new MqttMotionInput({
        url: 'mqtt://192.0.2.10:1883',
        username: 'onvif',
        password: 'secret',
        logger,
        metrics,
        connect: (...args) => {
            connectArgs = args;
            return client;
        },
    });
    return { client, input, connectArgs: () => connectArgs };
}

test('connects with the configured login and subscribes on every connect', () => {
    const { client, input, connectArgs } = setup();
    input.watch({ topic: 'frigate/front/motion' }, () => {});
    input.watch({ topic: 'frigate/back/motion' }, () => {});
    input.start();

    const [url, options] = connectArgs();
    assert.equal(url, 'mqtt://192.0.2.10:1883');
    assert.equal(options.username, 'onvif');
    assert.equal(options.password, 'secret');
    assert.equal(options.resubscribe, false);

    client.emit('connect');
    client.emit('connect');
    assert.equal(client.subscriptions.length, 2);
    assert.deepEqual(client.subscriptions[0], { topics: ['frigate/front/motion', 'frigate/back/motion'], options: { qos: 1 } });
});

test('ON and OFF switch motion, repeats and unknown payloads do not', () => {
    const { client, input } = setup();
    const changes = [];
    input.watch({ topic: 'cam/motion' }, (active) => changes.push(active));
    input.start();
    client.emit('connect');

    client.message('cam/motion', 'ON');
    client.message('cam/motion', ' ON\n');
    client.message('cam/motion', 'maybe');
    client.message('other/topic', 'OFF');
    client.message('cam/motion', 'x'.repeat(1000));
    client.message('cam/motion', 'OFF');

    assert.deepEqual(changes, [true, false]);
});

test('custom payloads and several cameras on one topic', () => {
    const { client, input } = setup();
    const first = [];
    const second = [];
    input.watch({ topic: 'ha/motion', payloadOn: 'on', payloadOff: 'off' }, (active) => first.push(active));
    input.watch({ topic: 'ha/motion', payloadOn: 'on', payloadOff: 'off' }, (active) => second.push(active));
    input.start();

    client.message('ha/motion', 'on');
    client.message('ha/motion', 'ON');
    assert.deepEqual(first, [true]);
    assert.deepEqual(second, [true]);
});

test('resetAfter ends motion when no new ON arrives', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, input } = setup();
    const changes = [];
    input.watch({ topic: 'cam/motion', resetAfter: 30 }, (active) => changes.push(active));
    input.start();

    client.message('cam/motion', 'ON');
    t.mock.timers.tick(20_000);
    client.message('cam/motion', 'ON'); // restarts the timer
    t.mock.timers.tick(20_000);
    assert.deepEqual(changes, [true]);

    t.mock.timers.tick(10_000);
    assert.deepEqual(changes, [true, false]);
});

test('losing the broker resets motion and the connected gauge', () => {
    const metrics = new Metrics();
    const { client, input } = setup({ metrics });
    const changes = [];
    input.watch({ topic: 'cam/motion' }, (active) => changes.push(active));
    input.start();
    assert.match(metrics.render(), /onvif_server_mqtt_connected 0/);

    client.emit('connect');
    assert.match(metrics.render(), /onvif_server_mqtt_connected 1/);
    client.message('cam/motion', 'ON');

    client.emit('close');
    client.emit('close'); // reconnect attempts close again - no second reset
    assert.deepEqual(changes, [true, false]);
    assert.match(metrics.render(), /onvif_server_mqtt_connected 0/);
});

test('close() ends the client and pending resets', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, input } = setup();
    const changes = [];
    input.watch({ topic: 'cam/motion', resetAfter: 5 }, (active) => changes.push(active));
    input.start();
    client.message('cam/motion', 'ON');

    await input.close();
    t.mock.timers.tick(10_000);
    assert.equal(client.ended, true);
    assert.deepEqual(changes, [true]);
});

test('redactUrl hides credentials', () => {
    assert.equal(redactUrl('mqtt://user:pw@192.0.2.10:1883'), 'mqtt://192.0.2.10:1883');
    assert.equal(redactUrl('not a url'), '<invalid url>');
});
