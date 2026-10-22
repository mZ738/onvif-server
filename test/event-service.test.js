import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { EventService, LIMITS, escapeXml, parseDuration, parseTermination, parseTopicFilter } from '../src/event-service.js';
import { createServer } from '../src/onvif-server.js';
import { createLogger } from '../src/logger.js';
import { Metrics } from '../src/metrics.js';
import { validCamera } from './helpers.js';

const logger = createLogger({ level: 'error' });

const ENVELOPE_START = '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"'
    + ' xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:tev="http://www.onvif.org/ver10/events/wsdl"'
    + ' xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:tns1="http://www.onvif.org/ver10/topics">';

function envelope(body, messageId) {
    const header = messageId ? `<s:Header><a:MessageID>${messageId}</a:MessageID></s:Header>` : '';
    return `${ENVELOPE_START}${header}<s:Body>${body}</s:Body></s:Envelope>`;
}

async function post(url, body, messageId) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/soap+xml' },
        body: envelope(body, messageId),
    });
    return { status: response.status, text: await response.text() };
}

const subscribe = (filter = '', termination = 'PT60S') => '<tev:CreatePullPointSubscription>'
    + (filter ? `<tev:Filter><wsnt:TopicExpression Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">${filter}</wsnt:TopicExpression></tev:Filter>` : '')
    + `<tev:InitialTerminationTime>${termination}</tev:InitialTerminationTime></tev:CreatePullPointSubscription>`;

const pull = (timeout = 'PT0S', limit = 10) => `<tev:PullMessages><tev:Timeout>${timeout}</tev:Timeout><tev:MessageLimit>${limit}</tev:MessageLimit></tev:PullMessages>`;

const addressOf = (text) => /<wsa:Address>([^<]+)<\/wsa:Address>/.exec(text)?.[1];
const messagesIn = (text) => [...text.matchAll(/<wsnt:Topic[^>]*>([^<]+)<\/wsnt:Topic>.*?PropertyOperation="(\w+)".*?Name="(?:IsMotion|State)" Value="(\w+)"/g)]
    .map(([, topic, operation, value]) => `${topic} ${operation} ${value}`);

function localCamera(overrides = {}) {
    const camera = validCamera(overrides);
    delete camera.mac;
    camera.hostname = '127.0.0.1';
    camera.ports = { server: 0, rtsp: 8554, snapshot: 8580 };
    return camera;
}

/** An EventService on its own HTTP server, for limits and a controllable clock. */
async function standalone(t, { limits = {}, now } = {}) {
    const service = new EventService({
        baseUrl: () => `http://127.0.0.1:${server.address().port}`,
        logger,
        metrics: new Metrics(),
        camera: 'Test',
        now,
        limits: { ...LIMITS, ...limits },
    });
    const server = http.createServer((request, response) => {
        const { pathname } = new URL(request.url, 'http://localhost');
        if (service.handles(pathname)) service.handle(request, response, pathname);
        else response.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        service.close();
        return new Promise((resolve) => server.close(resolve));
    });
    return { service, url: `http://127.0.0.1:${server.address().port}/onvif/events_service` };
}

test('parseDuration covers the forms NVRs send', () => {
    assert.equal(parseDuration('PT60S'), 60_000);
    assert.equal(parseDuration('PT1M30S'), 90_000);
    assert.equal(parseDuration('PT0.5S'), 500);
    assert.equal(parseDuration('P1DT1H'), 90_000_000);
    assert.equal(parseDuration('PT'), null);
    assert.equal(parseDuration('P1Y'), null);
    assert.equal(parseDuration('60'), null);
    assert.equal(parseDuration(undefined), null);
});

test('parseTermination accepts durations and absolute times', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    assert.equal(parseTermination('PT10S', now), 10_000);
    assert.equal(parseTermination('2026-10-22T12:01:00Z', now), 60_000);
    assert.equal(parseTermination('soon', now), null);
    assert.equal(parseTermination('', now), null);
});

test('parseTopicFilter matches prefixes, alternatives and ignores namespace prefixes', () => {
    assert.equal(parseTopicFilter(undefined), null);
    assert.deepEqual(parseTopicFilter({ TopicExpression: { _: 'tns1:RuleEngine//.', $: {} } }), ['RuleEngine/CellMotionDetector/Motion']);
    assert.deepEqual(parseTopicFilter({ TopicExpression: 'tns1:VideoSource/MotionAlarm|tns1:RuleEngine/CellMotionDetector/Motion' }).sort(),
        ['RuleEngine/CellMotionDetector/Motion', 'VideoSource/MotionAlarm']);
    assert.deepEqual(parseTopicFilter({ TopicExpression: 'tns1:Device/Trigger/DigitalInput' }), []);
});

test('escapeXml escapes markup and quotes', () => {
    assert.equal(escapeXml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;');
});

test('without motion: no event capability, no event service', async (t) => {
    const server = createServer(localCamera(), logger);
    await server.startServer();
    t.after(() => server.close());

    const device = server.onvif.DeviceService.Device;
    assert.equal(device.GetCapabilities({}).Capabilities.Events, undefined);
    assert.equal(device.GetServices().Service.length, 2);

    const response = await post(`http://127.0.0.1:${server.address().port}/onvif/events_service`, subscribe());
    assert.equal(response.status, 404);
});

test('with motion: Events sit between Device and Media and serialize over SOAP', async (t) => {
    const server = createServer(localCamera({ motion: { topic: 'cams/front/motion' } }), logger);
    await server.startServer();
    t.after(() => server.close());
    const { port } = server.address();

    const { Capabilities } = server.onvif.DeviceService.Device.GetCapabilities({});
    assert.deepEqual(Object.keys(Capabilities), ['Device', 'Events', 'Media']);
    assert.equal(server.onvif.DeviceService.Device.GetCapabilities({ Category: 'Events' }).Capabilities.Media, undefined);
    assert.ok(server.onvif.DeviceService.Device.GetServices().Service.some((s) => s.Namespace === 'http://www.onvif.org/ver10/events/wsdl'));

    const response = await fetch(`http://127.0.0.1:${port}/onvif/device_service`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/soap+xml' },
        body: '<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://www.onvif.org/ver10/device/wsdl"><s:Body><d:GetCapabilities/></s:Body></s:Envelope>',
    });
    const text = await response.text();
    assert.equal(response.status, 200, text.slice(0, 300));
    assert.match(text, /Events>\s*<[^>]*XAddr>http:\/\/127\.0\.0\.1:0\/onvif\/events_service</);
    assert.match(text, /WSPullPointSupport>true</);
});

test('a subscription starts with the current state and receives changes', async (t) => {
    const camera = localCamera({ motion: { topic: 'cams/front/motion' } });
    const server = createServer(camera, logger);
    await server.startServer();
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}/onvif/events_service`;

    const created = await post(base, subscribe(), 'urn:uuid:1');
    assert.equal(created.status, 200, created.text);
    assert.match(created.text, /<wsa:RelatesTo>urn:uuid:1<\/wsa:RelatesTo>/);
    assert.match(created.text, /CreatePullPointSubscriptionResponse<\/wsa:Action>/);
    const address = addressOf(created.text);
    assert.ok(address.startsWith(`${base}/subscription/`), address);

    const initial = await post(address, pull());
    assert.deepEqual(messagesIn(initial.text), [
        'tns1:RuleEngine/CellMotionDetector/Motion Initialized false',
        'tns1:VideoSource/MotionAlarm Initialized false',
    ]);

    // A long poll is answered as soon as motion starts.
    const started = Date.now();
    const waiting = post(address, pull('PT20S'));
    setTimeout(() => server.setMotion(true), 50);
    const changed = await waiting;
    assert.ok(Date.now() - started < 5_000);
    assert.deepEqual(messagesIn(changed.text), [
        'tns1:RuleEngine/CellMotionDetector/Motion Changed true',
        'tns1:VideoSource/MotionAlarm Changed true',
    ]);

    server.setMotion(true); // unchanged - nothing new
    const synchronized = await post(address, '<tev:SetSynchronizationPoint/>');
    assert.equal(synchronized.status, 200);
    assert.deepEqual(messagesIn((await post(address, pull())).text), [
        'tns1:RuleEngine/CellMotionDetector/Motion Initialized true',
        'tns1:VideoSource/MotionAlarm Initialized true',
    ]);
});

test('topic filters, message limits, renew and unsubscribe', async (t) => {
    const { service, url } = await standalone(t);

    const filtered = addressOf((await post(url, subscribe('tns1:VideoSource/MotionAlarm'))).text);
    assert.deepEqual(messagesIn((await post(filtered, pull())).text), ['tns1:VideoSource/MotionAlarm Initialized false']);

    const all = addressOf((await post(url, subscribe())).text);
    service.setMotion(true);
    service.setMotion(false);
    // Queued: 2 x Initialized, 2 x Changed true, 2 x Changed false.
    const first = messagesIn((await post(all, pull('PT0S', 3))).text);
    assert.equal(first.length, 3);
    const rest = messagesIn((await post(all, pull('PT0S', 10))).text);
    assert.deepEqual(rest, [
        'tns1:VideoSource/MotionAlarm Changed true',
        'tns1:RuleEngine/CellMotionDetector/Motion Changed false',
        'tns1:VideoSource/MotionAlarm Changed false',
    ]);

    const renewed = await post(all, '<wsnt:Renew><wsnt:TerminationTime>PT120S</wsnt:TerminationTime></wsnt:Renew>');
    assert.equal(renewed.status, 200);
    assert.match(renewed.text, /RenewResponse/);

    assert.equal((await post(all, '<wsnt:Unsubscribe/>')).status, 200);
    const gone = await post(all, pull());
    assert.equal(gone.status, 400);
    assert.match(gone.text, /Unknown or expired subscription/);
    assert.equal(service.subscriptionCount, 1);
});

test('subscriptions expire, pulling keeps them alive', async (t) => {
    let now = Date.parse('2026-10-22T12:00:00Z');
    const { url } = await standalone(t, { now: () => now });

    const idle = addressOf((await post(url, subscribe('', 'PT10S'))).text);
    const active = addressOf((await post(url, subscribe('', 'PT10S'))).text);

    now += 8_000;
    assert.equal((await post(active, pull())).status, 200);
    now += 8_000;
    assert.equal((await post(active, pull())).status, 200);
    assert.equal((await post(idle, pull())).status, 400);
});

test('the oldest subscription makes room when the limit is reached', async (t) => {
    const { service, url } = await standalone(t, { limits: { maxSubscriptions: 2 } });

    const first = addressOf((await post(url, subscribe())).text);
    await post(url, subscribe());
    const third = addressOf((await post(url, subscribe())).text);

    assert.equal(service.subscriptionCount, 2);
    assert.equal((await post(first, pull())).status, 400);
    assert.equal((await post(third, pull())).status, 200);
});

test('a slow subscriber does not queue without bound', async (t) => {
    const { service, url } = await standalone(t, { limits: { maxQueuedMessages: 4 } });
    const address = addressOf((await post(url, subscribe())).text);

    for (let i = 0; i < 10; i++) service.setMotion(i % 2 === 0);
    assert.equal(messagesIn((await post(address, pull('PT0S', 100))).text).length, 4);
});

test('close() answers a waiting PullMessages', async (t) => {
    const { service, url } = await standalone(t);
    const address = addressOf((await post(url, subscribe())).text);
    await post(address, pull());

    const waiting = post(address, pull('PT50S'));
    setTimeout(() => service.close(), 50);
    const response = await waiting;
    assert.equal(response.status, 200);
    assert.deepEqual(messagesIn(response.text), []);
});

test('bad requests get SOAP faults, not crashes', async (t) => {
    const { url } = await standalone(t, { limits: { maxBodyBytes: 2048 } });

    const malformed = await fetch(url, { method: 'POST', body: '<s:Envelope' });
    assert.equal(malformed.status, 400);
    assert.match(await malformed.text(), /ter:WellFormed/);

    assert.equal((await fetch(url)).status, 405);

    const unsupported = await post(url, '<wsnt:Subscribe/>');
    assert.equal(unsupported.status, 500);
    assert.match(unsupported.text, /ter:ActionNotSupported/);

    const wrongPlace = await post(url, pull());
    assert.equal(wrongPlace.status, 500);

    const unknown = await post(`${url}/subscription/does-not-exist`, pull());
    assert.equal(unknown.status, 400);

    const huge = await post(url, `<tev:GetEventProperties>${'x'.repeat(4096)}</tev:GetEventProperties>`);
    assert.equal(huge.status, 413);

    const injected = await post(url, '<tev:GetServiceCapabilities/>', 'a&lt;b&gt;');
    assert.match(injected.text, /<wsa:RelatesTo>a&lt;b&gt;<\/wsa:RelatesTo>/);
});

test('GetEventProperties describes both motion topics', async (t) => {
    const { url } = await standalone(t);
    const { status, text } = await post(url, '<tev:GetEventProperties/>');
    assert.equal(status, 200);
    assert.match(text, /<tns1:RuleEngine><CellMotionDetector><Motion wstop:topic="true">/);
    assert.match(text, /<tns1:VideoSource><MotionAlarm wstop:topic="true">/);
    assert.match(text, /<wsnt:FixedTopicSet>true<\/wsnt:FixedTopicSet>/);
});

test('metrics show subscriptions and motion state', async (t) => {
    const metrics = new Metrics();
    const server = createServer(localCamera({ name: 'Front', motion: { topic: 'm' } }), logger, { metrics });
    await server.startServer();
    t.after(() => server.close());

    await post(`http://127.0.0.1:${server.address().port}/onvif/events_service`, subscribe());
    server.setMotion(true);

    const text = metrics.render();
    assert.match(text, /onvif_server_event_subscriptions\{camera="Front"\} 1/);
    assert.match(text, /onvif_server_motion_active\{camera="Front"\} 1/);
    assert.match(text, /onvif_server_soap_requests_total\{camera="Front",service="EventService",method="CreatePullPointSubscription"\} 1/);
});
