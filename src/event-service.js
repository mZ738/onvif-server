import { randomUUID } from 'node:crypto';
import xml2js from 'xml2js';

/**
 * Onvif event service (PullPoint) for motion.
 *
 * Hand-written instead of served through node-soap: notification messages are
 * xs:any content that node-soap cannot serialize, and WS-BaseNotification
 * would pull another dozen OASIS/W3C schemas into the startup. The service only
 * implements the PullPoint flow NVRs use - CreatePullPointSubscription,
 * PullMessages, Renew, Unsubscribe, SetSynchronizationPoint - plus the
 * describing calls. Push subscriptions (wsnt:Subscribe) are not offered.
 */

export const EVENTS_PATH = '/onvif/events_service';
const SUBSCRIPTION_PREFIX = `${EVENTS_PATH}/subscription/`;

export const LIMITS = Object.freeze({
    maxSubscriptions: 10,
    maxQueuedMessages: 100,
    maxMessageLimit: 100,
    defaultTerminationMs: 60_000,
    minTerminationMs: 10_000,
    maxTerminationMs: 3_600_000,
    maxPullTimeoutMs: 60_000,
    maxBodyBytes: 64 * 1024,
    sweepIntervalMs: 15_000,
});

const VIDEO_SOURCE_TOKEN = 'video_src_token';
const VIDEO_SOURCE_CONFIG_TOKEN = 'video_src_config_token';
const ANALYTICS_CONFIG_TOKEN = 'video_analytics_config_token';
const MOTION_RULE = 'MotionDetectorRule';

const CONCRETE_SET_DIALECT = 'http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet';

const NAMESPACES = [
    'xmlns:env="http://www.w3.org/2003/05/soap-envelope"',
    'xmlns:wsa="http://www.w3.org/2005/08/addressing"',
    'xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"',
    'xmlns:wstop="http://docs.oasis-open.org/wsn/t-1"',
    'xmlns:tev="http://www.onvif.org/ver10/events/wsdl"',
    'xmlns:tt="http://www.onvif.org/ver10/schema"',
    'xmlns:tns1="http://www.onvif.org/ver10/topics"',
    'xmlns:ter="http://www.onvif.org/ver10/error"',
    'xmlns:xs="http://www.w3.org/2001/XMLSchema"',
].join(' ');

const ACTIONS = {
    GetServiceCapabilities: 'http://www.onvif.org/ver10/events/wsdl/EventPortType/GetServiceCapabilitiesResponse',
    GetEventProperties: 'http://www.onvif.org/ver10/events/wsdl/EventPortType/GetEventPropertiesResponse',
    CreatePullPointSubscription: 'http://www.onvif.org/ver10/events/wsdl/EventPortType/CreatePullPointSubscriptionResponse',
    PullMessages: 'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesResponse',
    SetSynchronizationPoint: 'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/SetSynchronizationPointResponse',
    Renew: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewResponse',
    Unsubscribe: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeResponse',
};
const FAULT_ACTION = 'http://www.w3.org/2005/08/addressing/soap/fault';

/**
 * The two motion topics real cameras commonly send: the rule engine's cell
 * motion detector (Profile S/T) and the older video source alarm. Clients
 * differ in which one they read, so both are published.
 */
const TOPICS = [
    {
        topic: 'RuleEngine/CellMotionDetector/Motion',
        source: [
            ['VideoSourceConfigurationToken', VIDEO_SOURCE_CONFIG_TOKEN],
            ['VideoAnalyticsConfigurationToken', ANALYTICS_CONFIG_TOKEN],
            ['Rule', MOTION_RULE],
        ],
        sourceTypes: ['tt:ReferenceToken', 'tt:ReferenceToken', 'xs:string'],
        dataItem: 'IsMotion',
    },
    {
        topic: 'VideoSource/MotionAlarm',
        source: [['Source', VIDEO_SOURCE_TOKEN]],
        sourceTypes: ['tt:ReferenceToken'],
        dataItem: 'State',
    },
];

export function escapeXml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

const DURATION_RE = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * xs:duration in milliseconds. Years and months have no fixed length and are
 * not used by NVRs for subscriptions, so they are rejected.
 * @returns {number | null}
 */
export function parseDuration(text) {
    if (typeof text !== 'string') return null;
    const match = DURATION_RE.exec(text.trim());
    if (!match || text.trim() === 'P' || text.trim().endsWith('T')) return null;
    const [, days = 0, hours = 0, minutes = 0, seconds = 0] = match;
    return Math.round(((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000 + Number(seconds) * 1000);
}

/**
 * wsnt:AbsoluteOrRelativeTimeType - a duration or an absolute dateTime.
 * @returns {number | null} the requested lifetime in milliseconds from now
 */
export function parseTermination(text, now) {
    if (typeof text !== 'string' || text.trim() === '') return null;
    const trimmed = text.trim();
    if (trimmed.startsWith('P')) return parseDuration(trimmed);
    const absolute = Date.parse(trimmed);
    return Number.isNaN(absolute) ? null : absolute - now;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

/** Text content of an xml2js node, whether or not it carried attributes. */
function textOf(node) {
    if (node === undefined || node === null) return undefined;
    if (typeof node === 'string') return node;
    if (typeof node === 'object' && typeof node._ === 'string') return node._;
    return undefined;
}

/** "tns1:RuleEngine/CellMotionDetector//." -> "RuleEngine/CellMotionDetector" */
function normalizeTopic(expression) {
    return expression
        .trim()
        .replace(/\/\/\.$/, '')
        .split('/')
        .map((segment) => segment.replace(/^[^:]*:/, ''))
        .filter(Boolean)
        .join('/');
}

/**
 * The topics a subscription wants, or null for all of them. Only topic
 * expressions are evaluated; message content filters are ignored, so a client
 * using them receives more, never less, than it asked for.
 */
export function parseTopicFilter(filter) {
    const expression = textOf(filter?.TopicExpression);
    if (!expression) return null;
    const wanted = expression.split('|').map(normalizeTopic).filter(Boolean);
    if (wanted.length === 0) return null;
    return TOPICS
        .filter(({ topic }) => wanted.some((prefix) => topic === prefix || topic.startsWith(`${prefix}/`)))
        .map(({ topic }) => topic);
}

function motionMessage({ topic, source, dataItem }, active, operation, utcTime) {
    const sourceItems = source
        .map(([name, value]) => `<tt:SimpleItem Name="${name}" Value="${escapeXml(value)}"/>`)
        .join('');
    return '<wsnt:NotificationMessage>'
        + `<wsnt:Topic Dialect="${CONCRETE_SET_DIALECT}">tns1:${topic}</wsnt:Topic>`
        + '<wsnt:Message>'
        + `<tt:Message UtcTime="${utcTime}" PropertyOperation="${operation}">`
        + `<tt:Source>${sourceItems}</tt:Source>`
        + `<tt:Data><tt:SimpleItem Name="${dataItem}" Value="${active}"/></tt:Data>`
        + '</tt:Message>'
        + '</wsnt:Message>'
        + '</wsnt:NotificationMessage>';
}

function topicSet() {
    const description = ({ source, sourceTypes, dataItem }) => '<tt:MessageDescription IsProperty="true">'
        + `<tt:Source>${source.map(([name], i) => `<tt:SimpleItemDescription Name="${name}" Type="${sourceTypes[i]}"/>`).join('')}</tt:Source>`
        + `<tt:Data><tt:SimpleItemDescription Name="${dataItem}" Type="xs:boolean"/></tt:Data>`
        + '</tt:MessageDescription>';
    const [cell, alarm] = TOPICS;
    return '<wstop:TopicSet>'
        + `<tns1:RuleEngine><CellMotionDetector><Motion wstop:topic="true">${description(cell)}</Motion></CellMotionDetector></tns1:RuleEngine>`
        + `<tns1:VideoSource><MotionAlarm wstop:topic="true">${description(alarm)}</MotionAlarm></tns1:VideoSource>`
        + '</wstop:TopicSet>';
}

class SoapFault extends Error {
    constructor(status, code, subcode, reason) {
        super(reason);
        this.status = status;
        this.code = code;
        this.subcode = subcode;
    }
}

const unknownSubscription = () => new SoapFault(400, 'env:Sender', 'ter:InvalidArgVal', 'Unknown or expired subscription');

export class EventService {
    #baseUrl;
    #logger;
    #metrics;
    #labels;
    #now;
    #limits;
    #subscriptions = new Map();
    #motion = false;
    #motionSince;
    #sweepTimer;
    #closed = false;

    /**
     * @param {object} options
     * @param {() => string} options.baseUrl  e.g. () => 'http://192.0.2.5:8081' - where subscription references point to
     * @param {() => number} [options.now] clock, injectable for tests
     */
    constructor({ baseUrl, logger, metrics = null, camera, now = Date.now, limits = LIMITS }) {
        this.#baseUrl = baseUrl;
        this.#logger = logger;
        this.#metrics = metrics;
        this.#labels = { camera };
        this.#now = now;
        this.#limits = limits;
        this.#motionSince = new Date(now()).toISOString();

        this.#metrics?.set('onvif_server_motion_active', 'Motion state published to event subscribers (1 = motion).', this.#labels, 0);
        this.#updateSubscriptionGauge();

        this.#sweepTimer = setInterval(() => this.#sweep(), limits.sweepIntervalMs);
        this.#sweepTimer.unref();
    }

    get motion() {
        return this.#motion;
    }

    get subscriptionCount() {
        return this.#subscriptions.size;
    }

    /** Publishes a motion change to every subscription. Repeated states are ignored. */
    setMotion(active) {
        const state = Boolean(active);
        if (state === this.#motion || this.#closed) return;
        this.#motion = state;
        this.#motionSince = new Date(this.#now()).toISOString();
        this.#metrics?.set('onvif_server_motion_active', 'Motion state published to event subscribers (1 = motion).', this.#labels, state ? 1 : 0);
        this.#logger.debug(`motion ${state ? 'started' : 'ended'}, ${this.#subscriptions.size} subscriber(s)`);

        for (const subscription of this.#subscriptions.values()) this.#enqueue(subscription, 'Changed');
    }

    /** True when the path belongs to the event service. */
    handles(pathname) {
        return pathname === EVENTS_PATH || pathname.startsWith(SUBSCRIPTION_PREFIX);
    }

    async handle(request, response, pathname) {
        let operation = 'unknown';
        let relatesTo;
        try {
            if (request.method !== 'POST') {
                response.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain' });
                response.end('405 Method Not Allowed\n');
                return;
            }

            const envelope = await this.#parse(await this.#readBody(request));
            relatesTo = textOf(envelope.Header?.MessageID);
            const body = envelope.Body;
            operation = body && typeof body === 'object' ? Object.keys(body).find((key) => key !== '$') ?? 'unknown' : 'unknown';
            this.#metrics?.inc('onvif_server_soap_requests_total', 'SOAP requests by method.', { ...this.#labels, service: 'EventService', method: operation });

            const subscriptionId = pathname.startsWith(SUBSCRIPTION_PREFIX) ? pathname.slice(SUBSCRIPTION_PREFIX.length) : null;
            const result = await this.#dispatch(operation, body[operation] ?? {}, subscriptionId, response);
            if (result === null) return; // client went away while waiting
            this.#send(response, 200, ACTIONS[operation], relatesTo, result);
        } catch (error) {
            const fault = error instanceof SoapFault
                ? error
                : new SoapFault(500, 'env:Receiver', 'ter:Action', 'Internal error');
            if (!(error instanceof SoapFault)) this.#logger.error(`EventService ${operation} failed: ${error.message}`);
            else this.#logger.debug(`EventService ${operation}: ${fault.message}`);
            this.#metrics?.inc('onvif_server_soap_errors_total', 'SOAP requests answered with a fault or HTTP 500.', { ...this.#labels, service: 'EventService' });
            if (response.headersSent || response.destroyed) return;
            this.#send(response, fault.status, FAULT_ACTION, relatesTo, this.#faultBody(fault));
        }
    }

    /** Ends every subscription and answers waiting PullMessages, so shutdown is not held up by long polls. */
    close() {
        this.#closed = true;
        clearInterval(this.#sweepTimer);
        for (const subscription of this.#subscriptions.values()) this.#release(subscription);
        this.#subscriptions.clear();
        this.#updateSubscriptionGauge();
    }

    #dispatch(operation, args, subscriptionId, response) {
        if (subscriptionId === null) {
            switch (operation) {
                case 'GetServiceCapabilities': return this.#capabilitiesBody();
                case 'GetEventProperties': return this.#eventPropertiesBody();
                case 'CreatePullPointSubscription': return this.#createSubscription(args);
                default: break;
            }
        } else {
            const subscription = this.#subscriptions.get(subscriptionId);
            switch (operation) {
                case 'PullMessages': return this.#pull(this.#require(subscription), args, response);
                case 'Renew': return this.#renew(this.#require(subscription), args);
                case 'Unsubscribe': return this.#unsubscribe(this.#require(subscription));
                case 'SetSynchronizationPoint': return this.#synchronize(this.#require(subscription));
                default: break;
            }
        }
        throw new SoapFault(500, 'env:Receiver', 'ter:ActionNotSupported', `${operation} is not supported here`);
    }

    #require(subscription) {
        if (!subscription || subscription.terminationTime <= this.#now()) throw unknownSubscription();
        return subscription;
    }

    #capabilitiesBody() {
        return '<tev:GetServiceCapabilitiesResponse>'
            + '<tev:Capabilities WSSubscriptionPolicySupport="false" WSPausableSubscriptionManagerInterfaceSupport="false"'
            + ` MaxNotificationProducers="0" MaxPullPoints="${this.#limits.maxSubscriptions}" PersistentNotificationStorage="false"/>`
            + '</tev:GetServiceCapabilitiesResponse>';
    }

    #eventPropertiesBody() {
        return '<tev:GetEventPropertiesResponse>'
            + '<tev:TopicNamespaceLocation>http://www.onvif.org/onvif/ver10/topics/topicns.xml</tev:TopicNamespaceLocation>'
            + '<wsnt:FixedTopicSet>true</wsnt:FixedTopicSet>'
            + topicSet()
            + `<wsnt:TopicExpressionDialect>${CONCRETE_SET_DIALECT}</wsnt:TopicExpressionDialect>`
            + '<wsnt:TopicExpressionDialect>http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete</wsnt:TopicExpressionDialect>'
            + '<tev:MessageContentFilterDialect>http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter</tev:MessageContentFilterDialect>'
            + '<tev:MessageContentSchemaLocation>http://www.onvif.org/onvif/ver10/schema/onvif.xsd</tev:MessageContentSchemaLocation>'
            + '</tev:GetEventPropertiesResponse>';
    }

    #createSubscription(args) {
        const now = this.#now();
        const requested = parseTermination(textOf(args.InitialTerminationTime), now);
        const lifetime = clamp(requested ?? this.#limits.defaultTerminationMs, this.#limits.minTerminationMs, this.#limits.maxTerminationMs);

        this.#sweep();
        // NVRs re-subscribe after a restart without unsubscribing; the oldest
        // subscription is the one most likely abandoned, so it makes room.
        if (this.#subscriptions.size >= this.#limits.maxSubscriptions) {
            const [oldestId, oldest] = this.#subscriptions.entries().next().value;
            this.#release(oldest);
            this.#subscriptions.delete(oldestId);
            this.#logger.debug(`event subscription limit reached, dropped ${oldestId}`);
        }

        const subscription = {
            id: randomUUID(),
            lifetime,
            terminationTime: now + lifetime,
            topics: parseTopicFilter(args.Filter),
            queue: [],
            waiter: null,
        };
        this.#subscriptions.set(subscription.id, subscription);
        this.#updateSubscriptionGauge();
        this.#enqueue(subscription, 'Initialized');

        return '<tev:CreatePullPointSubscriptionResponse>'
            + `<tev:SubscriptionReference><wsa:Address>${escapeXml(`${this.#baseUrl()}${SUBSCRIPTION_PREFIX}${subscription.id}`)}</wsa:Address></tev:SubscriptionReference>`
            + `<wsnt:CurrentTime>${new Date(now).toISOString()}</wsnt:CurrentTime>`
            + `<wsnt:TerminationTime>${new Date(subscription.terminationTime).toISOString()}</wsnt:TerminationTime>`
            + '</tev:CreatePullPointSubscriptionResponse>';
    }

    async #pull(subscription, args, response) {
        const timeout = clamp(parseDuration(textOf(args.Timeout)) ?? 0, 0, this.#limits.maxPullTimeoutMs);
        const limit = clamp(Number.parseInt(textOf(args.MessageLimit) ?? '', 10) || 1, 1, this.#limits.maxMessageLimit);

        // Pulling keeps a subscription alive, as on common cameras: an NVR
        // that polls continuously should not lose events to a missed Renew.
        subscription.terminationTime = Math.max(subscription.terminationTime, this.#now() + subscription.lifetime);

        if (subscription.queue.length === 0 && timeout > 0) {
            // Only one long poll per subscription; an older one is answered empty.
            this.#release(subscription);
            // The response, not the request, reports a client that hung up:
            // a request emits 'close' as soon as its body has been read.
            const aborted = await new Promise((resolve) => {
                const onClose = () => finish(true);
                const finish = (wasAborted) => {
                    clearTimeout(timer);
                    response.off('close', onClose);
                    if (subscription.waiter === waiter) subscription.waiter = null;
                    resolve(wasAborted);
                };
                const timer = setTimeout(() => finish(false), timeout);
                const waiter = () => finish(false);
                subscription.waiter = waiter;
                response.once('close', onClose);
            });
            if (aborted) return null;
        }

        const messages = subscription.queue.splice(0, limit);
        const now = this.#now();
        return '<tev:PullMessagesResponse>'
            + `<tev:CurrentTime>${new Date(now).toISOString()}</tev:CurrentTime>`
            + `<tev:TerminationTime>${new Date(subscription.terminationTime).toISOString()}</tev:TerminationTime>`
            + messages.join('')
            + '</tev:PullMessagesResponse>';
    }

    #renew(subscription, args) {
        const now = this.#now();
        const requested = parseTermination(textOf(args.TerminationTime), now);
        const lifetime = clamp(requested ?? subscription.lifetime, this.#limits.minTerminationMs, this.#limits.maxTerminationMs);
        subscription.lifetime = lifetime;
        subscription.terminationTime = now + lifetime;
        return '<wsnt:RenewResponse>'
            + `<wsnt:TerminationTime>${new Date(subscription.terminationTime).toISOString()}</wsnt:TerminationTime>`
            + `<wsnt:CurrentTime>${new Date(now).toISOString()}</wsnt:CurrentTime>`
            + '</wsnt:RenewResponse>';
    }

    #unsubscribe(subscription) {
        this.#release(subscription);
        this.#subscriptions.delete(subscription.id);
        this.#updateSubscriptionGauge();
        return '<wsnt:UnsubscribeResponse/>';
    }

    #synchronize(subscription) {
        this.#enqueue(subscription, 'Initialized');
        return '<tev:SetSynchronizationPointResponse/>';
    }

    #enqueue(subscription, operation) {
        const utcTime = operation === 'Initialized' ? this.#motionSince : new Date(this.#now()).toISOString();
        for (const topic of TOPICS) {
            if (subscription.topics && !subscription.topics.includes(topic.topic)) continue;
            subscription.queue.push(motionMessage(topic, this.#motion, operation, utcTime));
        }
        // A subscriber that stopped pulling must not grow without bound.
        const excess = subscription.queue.length - this.#limits.maxQueuedMessages;
        if (excess > 0) subscription.queue.splice(0, excess);
        subscription.waiter?.();
    }

    /** Answers a waiting PullMessages, if any. */
    #release(subscription) {
        subscription.waiter?.();
    }

    #sweep() {
        const now = this.#now();
        let removed = false;
        for (const [id, subscription] of this.#subscriptions) {
            // A pending long poll keeps the subscription; its answer renews it.
            if (subscription.terminationTime > now || subscription.waiter) continue;
            this.#subscriptions.delete(id);
            removed = true;
        }
        if (removed) this.#updateSubscriptionGauge();
    }

    #updateSubscriptionGauge() {
        this.#metrics?.set('onvif_server_event_subscriptions', 'Open Onvif event (PullPoint) subscriptions.', this.#labels, this.#subscriptions.size);
    }

    #readBody(request) {
        const max = this.#limits.maxBodyBytes;
        return new Promise((resolve, reject) => {
            const chunks = [];
            let size = 0;
            request.on('data', (chunk) => {
                size += chunk.length;
                if (size > max) {
                    request.pause();
                    reject(new SoapFault(413, 'env:Sender', 'ter:InvalidArgVal', `Request larger than ${max} bytes`));
                    return;
                }
                chunks.push(chunk);
            });
            request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            request.on('error', reject);
        });
    }

    async #parse(xml) {
        let document;
        try {
            document = await xml2js.parseStringPromise(xml, {
                explicitArray: false,
                tagNameProcessors: [xml2js.processors.stripPrefix],
            });
        } catch {
            throw new SoapFault(400, 'env:Sender', 'ter:WellFormed', 'Malformed XML');
        }
        const envelope = document?.Envelope;
        if (!envelope || typeof envelope.Body !== 'object' || envelope.Body === null)
            throw new SoapFault(400, 'env:Sender', 'ter:WellFormed', 'Not a SOAP envelope');
        return envelope;
    }

    #faultBody(fault) {
        return '<env:Fault>'
            + `<env:Code><env:Value>${fault.code}</env:Value><env:Subcode><env:Value>${fault.subcode}</env:Value></env:Subcode></env:Code>`
            + `<env:Reason><env:Text xml:lang="en">${escapeXml(fault.message)}</env:Text></env:Reason>`
            + '</env:Fault>';
    }

    #send(response, status, action, relatesTo, body) {
        const header = `<wsa:Action>${action}</wsa:Action>${relatesTo ? `<wsa:RelatesTo>${escapeXml(relatesTo)}</wsa:RelatesTo>` : ''}`;
        const xml = `<?xml version="1.0" encoding="UTF-8"?><env:Envelope ${NAMESPACES}><env:Header>${header}</env:Header><env:Body>${body}</env:Body></env:Envelope>`;
        response.writeHead(status, {
            'Content-Type': 'application/soap+xml; charset=utf-8',
            'Content-Length': Buffer.byteLength(xml),
        });
        response.end(xml);
    }
}
