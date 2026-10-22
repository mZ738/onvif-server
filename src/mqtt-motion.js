import { connect as mqttConnect } from 'mqtt';

export const MOTION_DEFAULTS = Object.freeze({ payloadOn: 'ON', payloadOff: 'OFF' });

// Motion payloads are short words; anything longer is not one of them.
const MAX_PAYLOAD_BYTES = 256;
const RECONNECT_PERIOD_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;

/** The broker address for logs and --check: without credentials, should the URL carry any. */
export function redactUrl(url) {
    try {
        const parsed = new URL(url);
        parsed.username = '';
        parsed.password = '';
        return parsed.href;
    } catch {
        return '<invalid url>';
    }
}

/**
 * Motion input from MQTT: one broker connection for all cameras, each camera
 * watching one topic for an "on" and an "off" payload (Frigate's
 * `frigate/<camera>/motion` with ON/OFF, for example).
 *
 * While the broker is unreachable the state is unknown, so every camera falls
 * back to "no motion" instead of keeping a stale "motion" that would never end.
 */
export class MqttMotionInput {
    #url;
    #options;
    #logger;
    #metrics;
    #connect;
    #client = null;
    #connected = false;
    #watchers = new Map();

    /**
     * @param {object} options
     * @param {string} options.url       mqtt://, mqtts://, ws:// or wss://
     * @param {string} [options.password] from the environment, never from the config file
     * @param {Function} [options.connect] mqtt.connect, injectable for tests
     */
    constructor({ url, username, password, clientId, logger, metrics = null, connect = mqttConnect }) {
        this.#url = url;
        this.#options = {
            username,
            password,
            clientId: clientId ?? `onvif-server-${process.pid}`,
            reconnectPeriod: RECONNECT_PERIOD_MS,
            connectTimeout: CONNECT_TIMEOUT_MS,
            clean: true,
            // Subscriptions are (re)made on every connect below.
            resubscribe: false,
        };
        this.#logger = logger;
        this.#metrics = metrics;
        this.#connect = connect;
    }

    /**
     * Calls onChange(true|false) when the topic reports motion or its end.
     * @param {{ topic: string, payloadOn?: string, payloadOff?: string, resetAfter?: number }} motion
     */
    watch(motion, onChange) {
        const watcher = {
            payloadOn: String(motion.payloadOn ?? MOTION_DEFAULTS.payloadOn).trim(),
            payloadOff: String(motion.payloadOff ?? MOTION_DEFAULTS.payloadOff).trim(),
            resetAfterMs: motion.resetAfter ? motion.resetAfter * 1000 : 0,
            onChange,
            active: false,
            timer: null,
        };
        const watchers = this.#watchers.get(motion.topic) ?? [];
        watchers.push(watcher);
        this.#watchers.set(motion.topic, watchers);
    }

    get topics() {
        return [...this.#watchers.keys()];
    }

    start() {
        this.#setConnected(false);
        this.#logger.info(`connecting to MQTT broker ${redactUrl(this.#url)}`);
        const client = this.#connect(this.#url, this.#options);
        this.#client = client;

        client.on('connect', () => {
            this.#setConnected(true);
            this.#logger.info(`MQTT connected, watching ${this.#watchers.size} topic(s)`);
            client.subscribe(this.topics, { qos: 1 }, (error) => {
                if (error) this.#logger.error(`MQTT subscribe failed: ${error.message}`);
            });
        });

        client.on('message', (topic, payload) => this.#onMessage(topic, payload));

        client.on('close', () => {
            if (!this.#connected) return;
            this.#setConnected(false);
            this.#logger.warn(`MQTT connection lost, motion reset until it is back (retrying every ${RECONNECT_PERIOD_MS / 1000} s)`);
            this.#resetAll();
        });

        // mqtt.js keeps reconnecting on its own; errors are only reported.
        client.on('error', (error) => {
            this.#logger.error(`MQTT error: ${error.message}`, { code: error.code });
        });
    }

    async close() {
        for (const watchers of this.#watchers.values())
            for (const watcher of watchers) clearTimeout(watcher.timer);
        const client = this.#client;
        this.#client = null;
        if (client) await client.endAsync();
        this.#setConnected(false);
    }

    #onMessage(topic, payload) {
        const watchers = this.#watchers.get(topic);
        if (!watchers) return;
        if (payload.length > MAX_PAYLOAD_BYTES) {
            this.#logger.debug(`ignoring ${payload.length} byte MQTT payload on ${topic}`);
            return;
        }

        const text = payload.toString('utf8').trim();
        for (const watcher of watchers) {
            if (text === watcher.payloadOn) this.#set(watcher, true);
            else if (text === watcher.payloadOff) this.#set(watcher, false);
            else this.#logger.debug(`ignoring MQTT payload "${text}" on ${topic}, expected "${watcher.payloadOn}" or "${watcher.payloadOff}"`);
        }
    }

    #set(watcher, active) {
        clearTimeout(watcher.timer);
        watcher.timer = null;
        // Sources that only report the start of motion (or whose "off" got
        // lost) end after resetAfter seconds without a new "on".
        if (active && watcher.resetAfterMs > 0)
            watcher.timer = setTimeout(() => this.#set(watcher, false), watcher.resetAfterMs);
        if (watcher.active === active) return;
        watcher.active = active;
        watcher.onChange(active);
    }

    #resetAll() {
        for (const watchers of this.#watchers.values())
            for (const watcher of watchers) this.#set(watcher, false);
    }

    #setConnected(connected) {
        this.#connected = connected;
        this.#metrics?.set('onvif_server_mqtt_connected', 'Whether the MQTT motion input is connected to its broker.', {}, connected ? 1 : 0);
    }
}
