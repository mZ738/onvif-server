import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { Metrics, startMetricsServer } from '../src/metrics.js';
import { TcpProxy } from '../src/tcp-proxy.js';
import { validateConfig } from '../src/config-schema.js';
import { createLogger } from '../src/logger.js';
import { validConfig } from './helpers.js';

const logger = createLogger({ level: 'error' });

function sample(text, name, labels) {
    const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
    const line = text.split('\n').find((l) => l.startsWith(`${name}{`) && wanted.every((w) => l.includes(w)));
    return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1));
}

test('renders HELP, TYPE and labelled samples', () => {
    const metrics = new Metrics();
    metrics.inc('demo_total', 'A demo counter.', { a: '1' }, 3);
    metrics.set('demo_gauge', 'A demo gauge.', {}, 7);

    const text = metrics.render();
    assert.match(text, /^# HELP demo_total A demo counter\.$/m);
    assert.match(text, /^# TYPE demo_total counter$/m);
    assert.match(text, /^demo_total\{a="1"\} 3$/m);
    assert.match(text, /^demo_gauge 7$/m);
});

test('escapes backslashes, quotes and newlines in label values', () => {
    const metrics = new Metrics();
    metrics.inc('demo_total', 'x', { name: 'a"b\\c\nd' });
    assert.match(metrics.render(), /demo_total\{name="a\\"b\\\\c\\nd"\} 1/);
});

test('the endpoint serves /metrics and 404s everything else', async (t) => {
    const metrics = new Metrics();
    metrics.set('demo_gauge', 'x', {}, 1);
    const server = await startMetricsServer(metrics, { host: '127.0.0.1', port: 0 });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();

    const ok = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
    assert.match(await ok.text(), /^demo_gauge 1$/m);

    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
});

test('a forwarder counts connections and bytes per direction', async (t) => {
    const upstream = await new Promise((resolve) => {
        const server = net.createServer((socket) => socket.pipe(socket));
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
    const metrics = new Metrics();
    const proxy = new TcpProxy({
        listenHost: '127.0.0.1',
        listenPort: 0,
        targetHost: '127.0.0.1',
        targetPort: upstream.address().port,
        logger,
        metrics,
    });

    // Series exist before the first connection.
    const before = metrics.render();
    assert.equal(sample(before, 'onvif_server_proxy_connections', {}), 0);
    assert.equal(sample(before, 'onvif_server_proxy_bytes_total', { direction: 'to_client' }), 0);

    // listen() binds to listenPort 0 here, so read the real port back.
    await proxy.listen();
    t.after(async () => {
        await proxy.close();
        await new Promise((resolve) => upstream.close(resolve));
    });

    const { port } = proxy.address();

    await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port }, () => socket.write('hello'));
        socket.on('data', () => socket.end());
        socket.on('close', resolve);
        socket.on('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const text = metrics.render();
    assert.equal(sample(text, 'onvif_server_proxy_connections_total', {}), 1);
    assert.equal(sample(text, 'onvif_server_proxy_connections', {}), 0);
    assert.equal(sample(text, 'onvif_server_proxy_bytes_total', { direction: 'to_target' }), 5);
    assert.equal(sample(text, 'onvif_server_proxy_bytes_total', { direction: 'to_client' }), 5);
    const last = sample(text, 'onvif_server_proxy_last_transfer_timestamp_seconds', { direction: 'to_client' });
    assert.ok(Math.abs(last - Date.now() / 1000) < 5);
});

test('config validation of the metrics block', () => {
    assert.deepEqual(validateConfig({ ...validConfig(), metrics: { port: 9180 } }), []);
    assert.deepEqual(validateConfig({ ...validConfig(), metrics: { host: '127.0.0.1', port: 9180 } }), []);
    assert.ok(validateConfig({ ...validConfig(), metrics: { port: 'x' } }).some((p) => p.startsWith('metrics.port')));
    assert.ok(validateConfig({ ...validConfig(), metrics: true }).some((p) => p.startsWith('metrics:')));
});

test('max idle exposes one stalled connection next to a flowing one', async (t) => {
    // Upstream: the first connection gets data every 50 ms, the second none.
    let accepted = 0;
    const timers = [];
    const upstream = await new Promise((resolve) => {
        const server = net.createServer((socket) => {
            socket.on('error', () => {});
            if (accepted++ === 0) timers.push(setInterval(() => socket.write('x'), 50));
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
    const metrics = new Metrics();
    const proxy = new TcpProxy({
        listenHost: '127.0.0.1',
        listenPort: 0,
        targetHost: '127.0.0.1',
        targetPort: upstream.address().port,
        logger,
        metrics,
    });
    await proxy.listen();

    const idle = () => sample(metrics.render(), 'onvif_server_proxy_max_idle_seconds', { direction: 'to_client' });
    assert.equal(idle(), 0, 'no connection yet');

    const { port } = proxy.address();
    const open = () => new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port }, () => resolve(socket));
        socket.on('error', () => {});
    });
    const flowing = await open();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stalled = await open();
    t.after(async () => {
        for (const timer of timers) clearInterval(timer);
        flowing.destroy();
        stalled.destroy();
        await proxy.close();
        await new Promise((resolve) => upstream.close(resolve));
    });

    await new Promise((resolve) => setTimeout(resolve, 700));
    const bytesBefore = sample(metrics.render(), 'onvif_server_proxy_bytes_total', { direction: 'to_client' });
    assert.ok(bytesBefore > 0, 'the healthy connection keeps the byte counter growing');
    assert.ok(idle() >= 0.5, `stalled connection must show, got ${idle()}`);

    stalled.destroy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(idle() < 0.3, `after the stalled connection is gone only the flowing one counts, got ${idle()}`);
});
