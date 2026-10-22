import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import yaml from 'yaml';

import { createServer } from './src/onvif-server.js';
import { createConfig } from './src/config-builder.js';
import { validateConfig } from './src/config-schema.js';
import { TcpProxy } from './src/tcp-proxy.js';
import { planForwards } from './src/forwards.js';
import { Metrics, startMetricsServer } from './src/metrics.js';
import { checkConfig } from './src/check.js';
import { createLogger } from './src/logger.js';
import { MqttMotionInput } from './src/mqtt-motion.js';

const USAGE = `Virtual Onvif Server

Usage: node main.js [options] <config>

Options:
  -v, --version        show the version information
  -cc, --create-config create a new config by probing a real Onvif camera
  -t, --check          validate the config and show what would be served,
                       without opening any port (exit code 0 = ok)
  -d, --debug          show onvif requests
  -h, --help           show this help
`;

async function readVersion() {
    const file = path.join(import.meta.dirname, 'package.json');
    return JSON.parse(await fs.readFile(file, 'utf8')).version;
}

/**
 * A readline interface whose echo can be suppressed, so the Onvif password is
 * not printed to the terminal as it is typed. v1 did this with a muted stream;
 * the promises API needs the same treatment.
 */
function createPrompt() {
    let muted = false;
    const output = new Writable({
        write(chunk, encoding, callback) {
            if (!muted) process.stdout.write(chunk, encoding);
            callback();
        },
    });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
    return { rl, setMuted: (value) => { muted = value; } };
}

async function runCreateConfig(logger) {
    const { rl, setMuted } = createPrompt();

    try {
        const hostname = await rl.question('Onvif Server: ');
        const username = await rl.question('Onvif Username: ');

        process.stdout.write('Onvif Password: ');
        setMuted(true);
        const password = await rl.question('');
        setMuted(false);
        process.stdout.write('\n');

        logger.info('Generating config ...');

        const config = await createConfig(hostname, username, password, logger);

        if (!config) {
            logger.error('Failed to create config!');
            return 1;
        }

        process.stdout.write('# ==================== CONFIG START ====================\n');
        process.stdout.write(`${yaml.stringify(config)}\n`);
        process.stdout.write('# ===================== CONFIG END =====================\n');
        return 0;
    } finally {
        rl.close();
    }
}

async function loadConfig(file, logger) {
    let raw;
    try {
        raw = await fs.readFile(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            logger.error(`File not found: ${file}`);
            return null;
        }
        throw error;
    }

    let config;
    try {
        config = yaml.parse(raw);
    } catch (error) {
        logger.error(`Failed to read config, invalid yaml syntax: ${error.message}`);
        return null;
    }

    const problems = validateConfig(config);
    if (problems.length > 0) {
        logger.error(`Config is not valid (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
        for (const problem of problems) logger.error(`  ${problem}`);
        return null;
    }

    return config;
}

async function runServers(config, { debug, logger }) {
    const servers = [];
    const proxies = [];
    const cameras = [];
    const motionSources = [];

    const metrics = config.metrics ? new Metrics() : null;
    metrics?.set('onvif_server_build_info', 'Constant 1, labelled with the running version.', { version: await readVersion() }, 1);

    for (const cameraConfig of config.onvif) {
        const cameraLogger = logger.child({ camera: cameraConfig.name });
        const server = createServer(cameraConfig, cameraLogger, { metrics });

        if (!server.getHostname()) {
            cameraLogger.error(`Failed to find IP address for MAC address ${cameraConfig.mac}`);
            await shutdown(servers, proxies);
            return 1;
        }

        cameraLogger.info(`starting virtual onvif server on ${server.getHostname()}:${cameraConfig.ports.server}`);

        try {
            await server.startServer();
        } catch (error) {
            cameraLogger.error(`failed to start: ${error.message}`, { code: error.code });
            await shutdown(servers, proxies);
            return 1;
        }

        server.startDiscovery();
        if (debug) server.enableDebugOutput();
        servers.push(server);
        cameras.push({ host: server.getHostname(), camera: cameraConfig });
        if (cameraConfig.motion) motionSources.push({ motion: cameraConfig.motion, server });
    }

    let forwards;
    try {
        forwards = planForwards(cameras);
    } catch (error) {
        logger.error(`invalid forwarding setup: ${error.message}`);
        await shutdown(servers, proxies);
        return 1;
    }

    for (const { listenHost, listenPort, targetHost, targetPort } of forwards) {
        const proxy = new TcpProxy({ listenHost, listenPort, targetHost, targetPort, logger, metrics });

        logger.info(`starting tcp proxy ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`);

        try {
            await proxy.listen();
        } catch (error) {
            logger.error(`failed to start tcp proxy on ${listenHost}:${listenPort}: ${error.message}`, { code: error.code });
            await shutdown(servers, [...proxies, proxy]);
            return 1;
        }

        proxies.push(proxy);
    }

    // Started after the Onvif servers, so every motion change has somewhere to go.
    // Not fatal when the broker is down: streaming works without it and the
    // client keeps reconnecting.
    if (motionSources.length > 0) {
        const input = new MqttMotionInput({
            url: config.mqtt.url,
            username: config.mqtt.username,
            // Compose passes an unset variable as an empty string.
            password: process.env.MQTT_PASSWORD || undefined,
            clientId: config.mqtt.clientId,
            logger: logger.child({ component: 'mqtt' }),
            metrics,
        });
        for (const { motion, server } of motionSources) input.watch(motion, (active) => server.setMotion(active));
        input.start();
        servers.push({ close: () => input.close() });
    }

    if (metrics) {
        const { host = '0.0.0.0', port } = config.metrics;
        try {
            // Closed through the same path as servers and proxies.
            const metricsServer = await startMetricsServer(metrics, { host, port });
            servers.push({ close: () => new Promise((resolve) => metricsServer.close(resolve)) });
            logger.info(`serving metrics on http://${host}:${port}/metrics`);
        } catch (error) {
            logger.error(`failed to start metrics endpoint on ${host}:${port}: ${error.message}`, { code: error.code });
            await shutdown(servers, proxies);
            return 1;
        }
    }

    logger.info(`ready — ${cameras.length} virtual camera${cameras.length === 1 ? '' : 's'}, ${proxies.length} tcp proxies`);

    await waitForShutdownSignal(logger);
    await shutdown(servers, proxies);
    return 0;
}

function runCheck(config, configFile) {
    const { errors, warnings, report } = checkConfig(config);

    process.stdout.write(`${configFile}: ${config.onvif.length} virtual camera${config.onvif.length === 1 ? '' : 's'}\n`);
    for (const line of report) process.stdout.write(`${line}\n`);
    for (const warning of warnings) process.stdout.write(`warning: ${warning}\n`);
    for (const error of errors) process.stdout.write(`error: ${error}\n`);

    process.stdout.write(errors.length === 0 ? 'config ok\n' : `config has ${errors.length} error${errors.length === 1 ? '' : 's'}\n`);
    return errors.length === 0 ? 0 : 1;
}

function waitForShutdownSignal(logger) {
    return new Promise((resolve) => {
        const stop = (signal) => {
            logger.info(`received ${signal}, shutting down`);
            resolve();
        };
        process.once('SIGINT', () => stop('SIGINT'));
        process.once('SIGTERM', () => stop('SIGTERM'));
    });
}

async function shutdown(servers, proxies) {
    await Promise.allSettled([
        ...servers.map((server) => server.close()),
        ...proxies.map((proxy) => proxy.close()),
    ]);
}

async function main() {
    let parsed;
    try {
        parsed = parseArgs({
            options: {
                version: { type: 'boolean', short: 'v', default: false },
                'create-config': { type: 'boolean', default: false },
                check: { type: 'boolean', short: 't', default: false },
                debug: { type: 'boolean', short: 'd', default: false },
                help: { type: 'boolean', short: 'h', default: false },
            },
            allowPositionals: true,
            // Keep the original "-cc" spelling working.
            args: process.argv.slice(2).map((arg) => (arg === '-cc' ? '--create-config' : arg)),
        });
    } catch (error) {
        process.stderr.write(`${error.message}\n\n${USAGE}`);
        return 1;
    }

    const { values, positionals } = parsed;
    const logger = createLogger({ level: values.debug ? 'trace' : 'info' });

    if (values.help) {
        process.stdout.write(USAGE);
        return 0;
    }

    if (values.version) {
        process.stdout.write(`${await readVersion()}\n`);
        return 0;
    }

    if (values['create-config']) return runCreateConfig(logger);

    const configFile = positionals[0];
    if (!configFile) {
        logger.error('Please specify a config filename!');
        process.stderr.write(`\n${USAGE}`);
        return 1;
    }

    const config = await loadConfig(configFile, logger);
    if (!config) return 1;

    if (values.check) return runCheck(config, configFile);

    return runServers(config, { debug: values.debug, logger });
}

process.exitCode = await main();
