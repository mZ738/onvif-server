/**
 * Config validation.
 *
 * Without this, a typo'd or missing YAML key surfaces much later as an opaque
 * TypeError from inside the SOAP layer. Validating up front lets us point at
 * the exact path that is wrong, for every camera at once.
 */

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkPort(errors, path, value, { required = true } = {}) {
    if (value === undefined || value === null) {
        if (required) errors.push(`${path}: missing (expected a port number 1-65535)`);
        return;
    }
    if (!Number.isInteger(value) || value < 1 || value > 65535)
        errors.push(`${path}: expected a port number 1-65535, got ${JSON.stringify(value)}`);
}

function checkQuality(errors, path, quality, { required }) {
    if (quality === undefined || quality === null) {
        if (required) errors.push(`${path}: missing`);
        return;
    }
    if (!isPlainObject(quality)) {
        errors.push(`${path}: expected a mapping`);
        return;
    }

    for (const key of ['width', 'height', 'framerate', 'bitrate', 'quality']) {
        const value = quality[key];
        if (typeof value !== 'number' || Number.isNaN(value))
            errors.push(`${path}.${key}: expected a number, got ${JSON.stringify(value)}`);
    }

    if (typeof quality.rtsp !== 'string' || !quality.rtsp.startsWith('/'))
        errors.push(`${path}.rtsp: expected a path starting with "/", got ${JSON.stringify(quality.rtsp)}`);

    if (quality.snapshot !== undefined && typeof quality.snapshot !== 'string')
        errors.push(`${path}.snapshot: expected a path string`);
}

const AUDIO_ENCODINGS = ['G711', 'G726', 'AAC'];

function checkPositiveInteger(errors, path, value) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0))
        errors.push(`${path}: expected a positive whole number, got ${JSON.stringify(value)}`);
}

function checkAudio(errors, path, audio) {
    if (audio === undefined || audio === false || audio === true) return;
    if (!isPlainObject(audio)) {
        errors.push(`${path}: expected true or a mapping with encoding/bitrate/samplerate/channels`);
        return;
    }
    if (audio.encoding !== undefined && !AUDIO_ENCODINGS.includes(audio.encoding))
        errors.push(`${path}.encoding: expected one of ${AUDIO_ENCODINGS.join(', ')}, got ${JSON.stringify(audio.encoding)}`);
    checkPositiveInteger(errors, `${path}.bitrate`, audio.bitrate);
    checkPositiveInteger(errors, `${path}.samplerate`, audio.samplerate);
    if (audio.samplerate > 192)
        errors.push(`${path}.samplerate: Onvif expects kHz (e.g. 16), got ${audio.samplerate}`);
    if (audio.channels !== undefined && audio.channels !== 1 && audio.channels !== 2)
        errors.push(`${path}.channels: expected 1 or 2, got ${JSON.stringify(audio.channels)}`);
}

function checkCamera(errors, index, camera) {
    const path = `onvif[${index}]`;

    if (!isPlainObject(camera)) {
        errors.push(`${path}: expected a mapping`);
        return;
    }

    if (typeof camera.name !== 'string' || camera.name.trim() === '')
        errors.push(`${path}.name: expected a non-empty string`);

    if (typeof camera.uuid !== 'string' || camera.uuid.trim() === '')
        errors.push(`${path}.uuid: expected a uuid string`);

    // Either an explicit hostname or a MAC we can resolve to a local interface.
    if (camera.hostname === undefined) {
        if (typeof camera.mac !== 'string' || !MAC_RE.test(camera.mac))
            errors.push(`${path}.mac: expected a MAC address like "ab:cd:ef:01:02:03" (or set ${path}.hostname instead)`);
    } else if (typeof camera.hostname !== 'string' || camera.hostname.trim() === '') {
        errors.push(`${path}.hostname: expected a non-empty string`);
    }

    if (!isPlainObject(camera.ports)) {
        errors.push(`${path}.ports: expected a mapping with server/rtsp/snapshot`);
    } else {
        checkPort(errors, `${path}.ports.server`, camera.ports.server);
        checkPort(errors, `${path}.ports.rtsp`, camera.ports.rtsp);
        checkPort(errors, `${path}.ports.snapshot`, camera.ports.snapshot, { required: false });
    }

    if (!isPlainObject(camera.target)) {
        errors.push(`${path}.target: expected a mapping with hostname/ports`);
    } else {
        if (typeof camera.target.hostname !== 'string' || camera.target.hostname.trim() === '')
            errors.push(`${path}.target.hostname: expected the real camera's hostname or IP`);

        if (!isPlainObject(camera.target.ports)) {
            errors.push(`${path}.target.ports: expected a mapping with rtsp/snapshot`);
        } else {
            checkPort(errors, `${path}.target.ports.rtsp`, camera.target.ports.rtsp);
            checkPort(errors, `${path}.target.ports.snapshot`, camera.target.ports.snapshot, { required: false });
        }
    }

    checkQuality(errors, `${path}.highQuality`, camera.highQuality, { required: true });
    checkQuality(errors, `${path}.lowQuality`, camera.lowQuality, { required: false });
    checkAudio(errors, `${path}.audio`, camera.audio);
}

/**
 * @returns {string[]} human-readable problems; empty means the config is usable.
 */
export function validateConfig(config) {
    const errors = [];

    if (!isPlainObject(config)) return ['config: expected a mapping at the top level'];

    if (!Array.isArray(config.onvif)) {
        errors.push('onvif: expected a list of cameras');
        return errors;
    }

    if (config.onvif.length === 0) errors.push('onvif: no cameras defined');

    config.onvif.forEach((camera, index) => checkCamera(errors, index, camera));

    if (config.metrics !== undefined) {
        if (!isPlainObject(config.metrics)) {
            errors.push('metrics: expected a mapping with port (and optionally host)');
        } else {
            checkPort(errors, 'metrics.port', config.metrics.port);
            if (config.metrics.host !== undefined && (typeof config.metrics.host !== 'string' || config.metrics.host.trim() === ''))
                errors.push('metrics.host: expected an address to listen on, e.g. "0.0.0.0"');
        }
    }

    // Two virtual cameras on the same host:port would silently fight over the socket.
    const seen = new Map();
    config.onvif.forEach((camera, index) => {
        if (!isPlainObject(camera) || !isPlainObject(camera.ports)) return;
        for (const kind of ['server', 'rtsp', 'snapshot']) {
            const port = camera.ports[kind];
            if (port === undefined) continue;
            const key = `${camera.hostname ?? camera.mac}:${port}`;
            if (seen.has(key))
                errors.push(`onvif[${index}].ports.${kind}: port ${port} already used by ${seen.get(key)}`);
            else seen.set(key, `onvif[${index}]`);
        }
    });

    return errors;
}
