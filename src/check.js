import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createServer } from './onvif-server.js';
import { planForwards } from './forwards.js';
import { createLogger } from './logger.js';

const DEFAULT_VENDOR_DIR = path.join(import.meta.dirname, '..', 'wsdl', 'vendor');

/**
 * Compares wsdl/vendor/ against its SHA256SUMS.
 * @returns {{ state: 'missing' | 'ok' | 'damaged', files: number, problems: string[] }}
 */
export function verifyVendoredSchemas(vendorDir = DEFAULT_VENDOR_DIR) {
    const sumsFile = path.join(vendorDir, 'SHA256SUMS');
    if (!fs.existsSync(sumsFile)) return { state: 'missing', files: 0, problems: [] };

    const problems = [];
    const lines = fs.readFileSync(sumsFile, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
        const [expected, relative] = [line.slice(0, 64), line.slice(66)];
        const file = path.join(vendorDir, ...relative.split('/'));
        if (!fs.existsSync(file)) {
            problems.push(`${relative}: missing`);
            continue;
        }
        const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if (actual !== expected) problems.push(`${relative}: checksum mismatch`);
    }
    return { state: problems.length === 0 ? 'ok' : 'damaged', files: lines.length, problems };
}

function describeProfile(profile) {
    const video = profile.VideoEncoderConfiguration;
    const audio = profile.AudioEncoderConfiguration;
    const parts = [
        `${profile.Name}: ${video.Encoding} ${video.Resolution.Width}x${video.Resolution.Height}`,
        `${video.RateControl.FrameRateLimit} fps`,
        `${video.RateControl.BitrateLimit} kbit/s`,
    ];
    if (audio) parts.push(`audio ${audio.Encoding} ${audio.SampleRate} kHz ${audio.Bitrate} kbit/s`);
    return parts.join(', ');
}

/**
 * Dry run for an already schema-validated config: everything a start would
 * derive from it, without binding a single port. Safe to run next to a live
 * instance using the same addresses.
 *
 * @returns {{ errors: string[], warnings: string[], report: string[] }}
 */
export function checkConfig(config, { vendorDir = DEFAULT_VENDOR_DIR } = {}) {
    const errors = [];
    const warnings = [];
    const report = [];
    const silent = createLogger({ level: 'error' });
    const cameras = [];

    for (const cameraConfig of config.onvif) {
        // createServer() resolves a MAC to an address but opens nothing.
        const server = createServer(structuredClone(cameraConfig), silent);
        const host = server.getHostname();
        if (!host) {
            errors.push(`${cameraConfig.name}: no local IPv4 interface with MAC ${cameraConfig.mac}`);
            continue;
        }

        cameras.push({ host, camera: cameraConfig });
        report.push(`${cameraConfig.name} (uuid ${cameraConfig.uuid})`);
        report.push(`  onvif   http://${host}:${cameraConfig.ports.server}/onvif/device_service`);
        for (const profile of server.profiles) report.push(`  profile ${describeProfile(profile)}`);
        report.push(`  scopes  ${server.discoveryScopes().map((scope) => scope.replace('onvif://www.onvif.org/', '')).join(' ')}`);
    }

    try {
        const forwards = planForwards(cameras);
        report.push(`forwarders (${forwards.length}):`);
        for (const f of forwards) report.push(`  ${f.listenHost}:${f.listenPort} -> ${f.targetHost}:${f.targetPort}`);
    } catch (error) {
        errors.push(`forwarding: ${error.message}`);
    }

    if (config.metrics) report.push(`metrics http://${config.metrics.host ?? '0.0.0.0'}:${config.metrics.port}/metrics`);

    const schemas = verifyVendoredSchemas(vendorDir);
    if (schemas.state === 'ok') report.push(`schemas ${schemas.files} vendored files, checksums ok`);
    else if (schemas.state === 'missing') warnings.push('schemas not vendored - a start needs internet access (npm run vendor-schemas)');
    else warnings.push(`vendored schemas damaged, affected imports fall back to the internet: ${schemas.problems.join('; ')}`);

    return { errors, warnings, report };
}
