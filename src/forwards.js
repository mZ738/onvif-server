/**
 * Works out which TCP forwarders to start.
 *
 * Every virtual camera advertises its RTSP and snapshot URLs on its *own*
 * address, so every (listen address, listen port) pair needs its own listener.
 * The previous implementation keyed forwarders by target host and listen port
 * only. Two virtual cameras with the same port on different addresses then
 * collapsed into one entry, and only the last camera's address got a listener -
 * the others refused connections without any error at startup.
 *
 * @param {{ host: string, camera: object }[]} cameras resolved listen address plus camera config
 * @returns {{ listenHost: string, listenPort: number, targetHost: string, targetPort: number }[]}
 */
export function planForwards(cameras) {
    const plan = new Map();

    for (const { host, camera } of cameras) {
        const targetHost = camera.target.hostname;

        for (const kind of ['rtsp', 'snapshot']) {
            const listenPort = camera.ports?.[kind];
            const targetPort = camera.target.ports?.[kind];
            if (!listenPort || !targetPort) continue;

            const key = `${host}:${listenPort}`;
            const existing = plan.get(key);

            if (existing && (existing.targetHost !== targetHost || existing.targetPort !== targetPort))
                throw new Error(`${key} is configured to forward to both ${existing.targetHost}:${existing.targetPort} and ${targetHost}:${targetPort}`);

            plan.set(key, { listenHost: host, listenPort, targetHost, targetPort });
        }
    }

    return [...plan.values()];
}
