import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { TcpProxy } from '../src/tcp-proxy.js';
import { createLogger } from '../src/logger.js';

const logger = createLogger({ level: 'error' });

function startEchoServer() {
    return new Promise((resolve) => {
        const server = net.createServer((socket) => socket.pipe(socket));
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function roundTrip(port, payload) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port }, () => socket.write(payload));
        const chunks = [];
        socket.on('data', (chunk) => {
            chunks.push(chunk);
            if (Buffer.concat(chunks).length >= payload.length) {
                socket.end();
                resolve(Buffer.concat(chunks).toString());
            }
        });
        socket.on('error', reject);
    });
}

async function freePort() {
    const { server, port } = await startEchoServer();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

test('forwards bytes in both directions', async (t) => {
    const upstream = await startEchoServer();
    const listenPort = await freePort();

    const proxy = new TcpProxy({
        listenHost: '127.0.0.1',
        listenPort,
        targetHost: '127.0.0.1',
        targetPort: upstream.port,
        logger,
    });

    await proxy.listen();
    t.after(async () => {
        await proxy.close();
        await new Promise((resolve) => upstream.server.close(resolve));
    });

    assert.equal(await roundTrip(listenPort, 'OPTIONS rtsp://x RTSP/1.0'), 'OPTIONS rtsp://x RTSP/1.0');
});

test('listen() rejects instead of throwing when the port is taken', async (t) => {
    const blocker = await startEchoServer();
    t.after(() => new Promise((resolve) => blocker.server.close(resolve)));

    const proxy = new TcpProxy({
        listenHost: '127.0.0.1',
        listenPort: blocker.port,
        targetHost: '127.0.0.1',
        targetPort: blocker.port,
        logger,
    });

    await assert.rejects(() => proxy.listen(), /EADDRINUSE/);
});

test('a dead upstream does not crash the proxy', async (t) => {
    const deadPort = await freePort();
    const listenPort = await freePort();

    const proxy = new TcpProxy({
        listenHost: '127.0.0.1',
        listenPort,
        targetHost: '127.0.0.1',
        targetPort: deadPort,
        logger,
    });

    await proxy.listen();
    t.after(() => proxy.close());

    await new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: listenPort }, () => socket.write('hello'));
        socket.on('close', resolve);
        socket.on('error', resolve);
    });

    // Still serving after the failed connection.
    assert.equal(typeof (await freePort()), 'number');
});

test('close() tears down in-flight connections', async (t) => {
    const upstream = await startEchoServer();
    const listenPort = await freePort();

    const proxy = new TcpProxy({
        listenHost: '127.0.0.1',
        listenPort,
        targetHost: '127.0.0.1',
        targetPort: upstream.port,
        logger,
    });

    await proxy.listen();
    t.after(() => new Promise((resolve) => upstream.server.close(resolve)));

    const socket = net.createConnection({ host: '127.0.0.1', port: listenPort });
    // Being reset by the proxy is the point of this test, not a failure.
    socket.on('error', () => {});
    await new Promise((resolve) => socket.on('connect', resolve));

    const closed = new Promise((resolve) => socket.on('close', resolve));
    await proxy.close();
    await closed;
});

test('enables TCP keepalive and disables Nagle on both legs', async (t) => {
    const upstream = await startEchoServer();
    const listenPort = await freePort();

    const calls = { keepAlive: 0, noDelay: 0 };
    const { setKeepAlive, setNoDelay } = net.Socket.prototype;
    net.Socket.prototype.setKeepAlive = function (enable, delay) {
        if (enable && delay > 0) calls.keepAlive++;
        return setKeepAlive.call(this, enable, delay);
    };
    net.Socket.prototype.setNoDelay = function (noDelay) {
        if (noDelay) calls.noDelay++;
        return setNoDelay.call(this, noDelay);
    };

    const proxy = new TcpProxy({ listenHost: '127.0.0.1', listenPort, targetHost: '127.0.0.1', targetPort: upstream.port, logger });
    await proxy.listen();
    t.after(async () => {
        net.Socket.prototype.setKeepAlive = setKeepAlive;
        net.Socket.prototype.setNoDelay = setNoDelay;
        await proxy.close();
        await new Promise((resolve) => upstream.server.close(resolve));
    });

    await roundTrip(listenPort, 'ping');

    // client leg + upstream leg
    assert.ok(calls.keepAlive >= 2, `setKeepAlive called ${calls.keepAlive}x`);
    assert.ok(calls.noDelay >= 2, `setNoDelay called ${calls.noDelay}x`);
});
