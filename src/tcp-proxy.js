import net from 'node:net';

// A client that disappears without closing its connection (power loss, Wi-Fi
// drop, a crashed NVR process) otherwise leaves the forwarder writing into a
// full send queue until the kernel gives up, which takes many minutes.
const KEEPALIVE_DELAY_MS = 10_000;

function tune(socket) {
    socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
    // RTSP control messages and RTP-over-TCP packets are small and latency
    // sensitive; Nagle's algorithm only adds delay here.
    socket.setNoDelay(true);
}

const CONNECTIONS = 'onvif_server_proxy_connections';
const CONNECTIONS_HELP = 'Open client connections on this forwarder.';
const CONNECTIONS_TOTAL = 'onvif_server_proxy_connections_total';
const CONNECTIONS_TOTAL_HELP = 'Client connections accepted by this forwarder.';
const BYTES = 'onvif_server_proxy_bytes_total';
const BYTES_HELP = 'Bytes forwarded; direction to_client is camera to NVR.';
const LAST = 'onvif_server_proxy_last_transfer_timestamp_seconds';
const LAST_HELP = 'Unix time of the last forwarded chunk per direction. A stale to_client value on an open connection means a frozen stream.';
const MAX_IDLE = 'onvif_server_proxy_max_idle_seconds';
const MAX_IDLE_HELP = 'Longest time any single open connection has gone without data in this direction; 0 without connections. Unlike the byte counters it exposes one stalled connection next to healthy ones.';
const DIRECTIONS = ['to_client', 'to_target'];

function describeProxyMetrics(metrics, labels, connections) {
    // Export zero-valued series from the start, so "no connection yet" and
    // "metric missing" are distinguishable.
    metrics.set(CONNECTIONS, CONNECTIONS_HELP, labels, 0);
    metrics.inc(CONNECTIONS_TOTAL, CONNECTIONS_TOTAL_HELP, labels, 0);
    for (const direction of DIRECTIONS) metrics.inc(BYTES, BYTES_HELP, { ...labels, direction }, 0);
    metrics.describe(LAST, 'gauge', LAST_HELP);

    // An NVR often keeps several sessions per camera open. When one of them
    // stalls while another keeps flowing, the per-forwarder byte counters keep
    // growing; only a per-connection view shows the stall.
    metrics.collect(() => {
        const now = Date.now();
        for (const direction of DIRECTIONS) {
            let idle = 0;
            for (const connection of connections) idle = Math.max(idle, now - connection.last[direction]);
            metrics.set(MAX_IDLE, MAX_IDLE_HELP, { ...labels, direction }, Math.round(idle / 100) / 10);
        }
    });
}

function countConnection(metrics, labels, client, upstream, connection) {
    metrics.add(CONNECTIONS, CONNECTIONS_HELP, labels, 1);
    metrics.inc(CONNECTIONS_TOTAL, CONNECTIONS_TOTAL_HELP, labels);

    // Extra 'data' listeners only observe; pipe() keeps doing the forwarding.
    const count = (direction) => (chunk) => {
        const directed = { ...labels, direction };
        connection.last[direction] = Date.now();
        metrics.inc(BYTES, BYTES_HELP, directed, chunk.length);
        metrics.set(LAST, LAST_HELP, directed, Math.floor(connection.last[direction] / 1000));
    };
    upstream.on('data', count('to_client'));
    client.on('data', count('to_target'));
}

/**
 * A plain TCP forwarder, replacing the unmaintained `node-tcp-proxy` 0.0.x.
 *
 * Each virtual camera advertises RTSP/snapshot URLs on its own IP, so we accept
 * on that address and pipe both directions to the real camera. Errors are logged
 * and the pair torn down rather than thrown, so one dead camera cannot take the
 * process (and every other camera) with it.
 */
export class TcpProxy {
    #server;
    #sockets = new Set();
    #logger;
    #target;

    constructor({ listenHost, listenPort, targetHost, targetPort, logger, metrics = null }) {
        this.#logger = logger;
        this.#target = `${targetHost}:${targetPort}`;
        this.listenHost = listenHost;
        this.listenPort = listenPort;

        const labels = { listen: `${listenHost}:${listenPort}`, target: this.#target };
        const connections = new Set();
        if (metrics) describeProxyMetrics(metrics, labels, connections);

        this.#server = net.createServer((client) => {
            const upstream = net.createConnection({ host: targetHost, port: targetPort });

            this.#track(client);
            this.#track(upstream);
            tune(client);
            tune(upstream);

            // Idle time counts from the moment the connection was accepted.
            const opened = Date.now();
            const connection = { last: { to_client: opened, to_target: opened } };

            let tornDown = false;
            const teardown = () => {
                if (!tornDown && metrics) metrics.add(CONNECTIONS, CONNECTIONS_HELP, labels, -1);
                tornDown = true;
                connections.delete(connection);
                client.destroy();
                upstream.destroy();
            };

            // 'close' passes a boolean, not an Error - keep the handlers separate
            // so we never try to read .code/.message off `hadError`.
            const onError = (error) => {
                if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE')
                    this.#logger.debug(`proxy ${listenPort} -> ${this.#target}: ${error.message}`, { code: error.code });
                teardown();
            };

            client.on('error', onError);
            upstream.on('error', onError);
            client.on('close', teardown);
            upstream.on('close', teardown);

            client.pipe(upstream);
            upstream.pipe(client);

            if (metrics) {
                connections.add(connection);
                countConnection(metrics, labels, client, upstream, connection);
            }
        });

        this.#server.on('error', (error) => {
            this.#logger.error(`tcp proxy on port ${listenPort} failed: ${error.message}`);
        });
    }

    #track(socket) {
        this.#sockets.add(socket);
        socket.on('close', () => this.#sockets.delete(socket));
    }

    listen() {
        return new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            this.#server.once('error', onError);
            this.#server.listen(this.listenPort, this.listenHost, () => {
                this.#server.removeListener('error', onError);
                resolve();
            });
        });
    }

    /** The bound address, or null before listen(). Useful when listenPort is 0. */
    address() {
        return this.#server.address();
    }

    async close() {
        for (const socket of this.#sockets) socket.destroy();
        this.#sockets.clear();
        await new Promise((resolve) => this.#server.close(resolve));
    }
}
