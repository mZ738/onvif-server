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

    constructor({ listenHost, listenPort, targetHost, targetPort, logger }) {
        this.#logger = logger;
        this.#target = `${targetHost}:${targetPort}`;
        this.listenHost = listenHost;
        this.listenPort = listenPort;

        this.#server = net.createServer((client) => {
            const upstream = net.createConnection({ host: targetHost, port: targetPort });

            this.#track(client);
            this.#track(upstream);
            tune(client);
            tune(upstream);

            const teardown = () => {
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

    async close() {
        for (const socket of this.#sockets) socket.destroy();
        this.#sockets.clear();
        await new Promise((resolve) => this.#server.close(resolve));
    }
}
