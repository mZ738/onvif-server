import test from 'node:test';
import assert from 'node:assert/strict';

import { planForwards } from '../src/forwards.js';
import { validCamera } from './helpers.js';

const key = ({ listenHost, listenPort }) => `${listenHost}:${listenPort}`;

test('two cameras with the same ports on different addresses get a forwarder each', () => {
    // Regression: forwarders used to be keyed by listen port only, so the second
    // camera replaced the first and only one address had a listener.
    const plan = planForwards([
        { host: '192.0.2.21', camera: validCamera() },
        { host: '192.0.2.22', camera: validCamera() },
    ]);

    assert.deepEqual(plan.map(key).sort(), [
        '192.0.2.21:8554',
        '192.0.2.21:8580',
        '192.0.2.22:8554',
        '192.0.2.22:8580',
    ]);
});

test('forwards each listen port to the matching target port', () => {
    const [rtsp, snapshot] = planForwards([{ host: '192.0.2.21', camera: validCamera() }]);

    assert.deepEqual(rtsp, { listenHost: '192.0.2.21', listenPort: 8554, targetHost: '192.0.2.10', targetPort: 554 });
    assert.deepEqual(snapshot, { listenHost: '192.0.2.21', listenPort: 8580, targetHost: '192.0.2.10', targetPort: 80 });
});

test('skips the snapshot forwarder when no snapshot port is configured', () => {
    const camera = validCamera({ ports: { server: 8081, rtsp: 8554 } });
    assert.deepEqual(planForwards([{ host: '192.0.2.21', camera }]).map(key), ['192.0.2.21:8554']);
});

test('channels sharing one address and target are merged, not duplicated', () => {
    const plan = planForwards([
        { host: '192.0.2.21', camera: validCamera() },
        { host: '192.0.2.21', camera: validCamera() },
    ]);
    assert.equal(plan.length, 2);
});

test('rejects one listen address forwarding to two different targets', () => {
    const other = validCamera({ target: { hostname: '192.0.2.99', ports: { rtsp: 554, snapshot: 80 } } });
    assert.throws(
        () => planForwards([
            { host: '192.0.2.21', camera: validCamera() },
            { host: '192.0.2.21', camera: other },
        ]),
        /forward to both/,
    );
});
