import soap from 'soap';
import http from 'node:http';
import dgram from 'node:dgram';
import xml2js from 'xml2js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const ROOT = path.join(import.meta.dirname, '..');
const WSDL_DIR = path.join(ROOT, 'wsdl');
const SNAPSHOT_FILE = path.join(ROOT, 'resources', 'snapshot.png');

const WSDL_LOAD_TIMEOUT_MS = 60_000;
const VENDOR_DIR = path.join(WSDL_DIR, 'vendor');

/**
 * Maps an http(s) schema import to the copy stored by scripts/vendor-schemas.js
 * (wsdl/vendor/<host>/<path>). Anything not found locally is left to node-soap,
 * which fetches it from the internet as before.
 */
export function resolveImport(includePath, vendorDir = VENDOR_DIR) {
    if (!/^https?:\/\//.test(includePath)) return includePath;
    const { host, pathname } = new URL(includePath);
    const local = path.join(vendorDir, host, ...pathname.split('/').filter(Boolean));
    return fs.existsSync(local) ? local : includePath;
}

const DISCOVERY_PORT = 3702;
const DISCOVERY_GROUP = '239.255.255.250';

/** Standard (non-DST) UTC offset for the year the given date falls in. */
function standardTimezoneOffset(date) {
    const jan = new Date(date.getFullYear(), 0, 1);
    const jul = new Date(date.getFullYear(), 6, 1);
    return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
}

/** True when the given date is inside daylight saving time locally. */
function isDstObserved(date) {
    return date.getTimezoneOffset() < standardTimezoneOffset(date);
}

function getIpAddressFromMac(macAddress) {
    const interfaces = os.networkInterfaces();
    for (const networks of Object.values(interfaces))
        for (const network of networks ?? [])
            if (network.family === 'IPv4' && network.mac.toLowerCase() === macAddress.toLowerCase())
                return network.address;
    return null;
}

/** Onvif identifiers must not contain spaces. */
function slug(name) {
    return name.replaceAll(' ', '_');
}

export const AUDIO_DEFAULTS = Object.freeze({ encoding: 'AAC', bitrate: 64, samplerate: 16, channels: 1 });

/**
 * `audio: true` advertises the defaults, a mapping overrides single fields.
 * Units follow Onvif: bitrate in kbit/s, samplerate in kHz.
 */
function normalizeAudio(audio) {
    if (!audio) return null;
    return { ...AUDIO_DEFAULTS, ...(audio === true ? {} : audio) };
}

/** An Onvif "no such configuration" fault, as node-soap expects it to be thrown. */
function noConfigFault(text) {
    return {
        Fault: {
            Code: { Value: 'soap:Sender', Subcode: { value: 'ter:InvalidArgVal' } },
            Reason: { Text: text },
        },
    };
}

class OnvifServer {
    #config;
    #logger;
    #server;
    #discoverySocket;
    #deviceService;
    #mediaService;
    #discoveryMessageNo = 0;
    #snapshot;
    #metrics;

    constructor(config, logger, { metrics = null } = {}) {
        this.#config = config;
        this.#logger = logger;
        this.#metrics = metrics;

        if (!this.#config.hostname)
            this.#config.hostname = getIpAddressFromMac(this.#config.mac);

        this.videoSource = {
            attributes: { token: 'video_src_token' },
            Framerate: config.highQuality.framerate,
            Resolution: { Width: config.highQuality.width, Height: config.highQuality.height },
        };

        // Optional audio advertisement. The audio bytes already flow through the
        // RTSP forwarder unchanged; without these entries Onvif clients (UniFi
        // Protect among them) treat the camera as having no microphone.
        this.audio = normalizeAudio(config.audio);
        const audioUseCount = config.lowQuality ? 2 : 1;

        this.audioSource = this.audio && {
            attributes: { token: 'audio_src_token' },
            Channels: this.audio.channels,
        };

        this.audioSourceConfiguration = this.audio && {
            attributes: { token: 'audio_src_config_token' },
            Name: 'AudioSource',
            UseCount: audioUseCount,
            SourceToken: 'audio_src_token',
        };

        this.audioEncoderConfiguration = this.audio && {
            attributes: { token: 'audio_encoder_config_token' },
            Name: 'CardinalAudioConfiguration',
            UseCount: audioUseCount,
            Encoding: this.audio.encoding,
            Bitrate: this.audio.bitrate,
            SampleRate: this.audio.samplerate,
            Multicast: {
                Address: { Type: 'IPv4', IPv4Address: '0.0.0.0' },
                Port: 0,
                TTL: 0,
                AutoStart: false,
            },
            SessionTimeout: 'PT1000S',
        };

        this.profiles = [this.#buildProfile('MainStream', 'main_stream', 'encoder_hq_config_token', 'CardinalHqCameraConfiguration', config.highQuality)];

        if (config.lowQuality)
            this.profiles.push(this.#buildProfile('SubStream', 'sub_stream', 'encoder_lq_config_token', 'CardinalLqCameraConfiguration', config.lowQuality));

        this.onvif = this.#buildServices();
    }

    #buildProfile(name, token, encoderToken, encoderName, quality) {
        const { highQuality } = this.#config;

        // Key order is element order in the serialized XML, and tt:Profile is a
        // sequence: VideoSource, AudioSource, VideoEncoder, AudioEncoder, ...
        // The audio entries are therefore placed between, not appended.
        const profile = {
            Name: name,
            attributes: { token },
            VideoSourceConfiguration: {
                Name: 'VideoSource',
                UseCount: 2,
                attributes: { token: 'video_src_config_token' },
                SourceToken: 'video_src_token',
                Bounds: { attributes: { x: 0, y: 0, width: highQuality.width, height: highQuality.height } },
            },
        };

        if (this.audioSourceConfiguration) profile.AudioSourceConfiguration = this.audioSourceConfiguration;

        profile.VideoEncoderConfiguration = {
            attributes: { token: encoderToken },
            Name: encoderName,
            UseCount: 1,
            Encoding: 'H264',
            Resolution: { Width: quality.width, Height: quality.height },
            Quality: quality.quality,
            RateControl: {
                FrameRateLimit: quality.framerate,
                EncodingInterval: 1,
                BitrateLimit: quality.bitrate,
            },
            H264: { GovLength: quality.framerate, H264Profile: 'Main' },
            SessionTimeout: 'PT1000S',
        };

        if (this.audioEncoderConfiguration) profile.AudioEncoderConfiguration = this.audioEncoderConfiguration;

        return profile;
    }

    #deviceServiceUri() {
        return `http://${this.#config.hostname}:${this.#config.ports.server}/onvif/device_service`;
    }

    #mediaServiceUri() {
        return `http://${this.#config.hostname}:${this.#config.ports.server}/onvif/media_service`;
    }

    #buildServices() {
        const config = this.#config;

        return {
            DeviceService: {
                Device: {
                    GetSystemDateAndTime: () => {
                        const now = new Date();
                        const offset = now.getTimezoneOffset();
                        const absOffset = Math.abs(offset);
                        const hours = Math.floor(absOffset / 60);
                        const minutes = absOffset % 60;
                        const tz = `UTC${offset < 0 ? '-' : '+'}${hours}${minutes === 0 ? '' : `:${minutes}`}`;

                        return {
                            SystemDateAndTime: {
                                DateTimeType: 'NTP',
                                DaylightSavings: isDstObserved(now),
                                TimeZone: { TZ: tz },
                                UTCDateTime: {
                                    Time: { Hour: now.getUTCHours(), Minute: now.getUTCMinutes(), Second: now.getUTCSeconds() },
                                    Date: { Year: now.getUTCFullYear(), Month: now.getUTCMonth() + 1, Day: now.getUTCDate() },
                                },
                                LocalDateTime: {
                                    Time: { Hour: now.getHours(), Minute: now.getMinutes(), Second: now.getSeconds() },
                                    Date: { Year: now.getFullYear(), Month: now.getMonth() + 1, Day: now.getDate() },
                                },
                                Extension: {},
                            },
                        };
                    },

                    GetCapabilities: (args) => {
                        const response = { Capabilities: {} };
                        const category = args?.Category;

                        if (category === undefined || category === 'All' || category === 'Device') {
                            response.Capabilities.Device = {
                                XAddr: this.#deviceServiceUri(),
                                Network: {
                                    IPFilter: false,
                                    ZeroConfiguration: false,
                                    IPVersion6: false,
                                    DynDNS: false,
                                    Extension: { Dot11Configuration: false, Extension: {} },
                                },
                                System: {
                                    DiscoveryResolve: false,
                                    DiscoveryBye: false,
                                    RemoteDiscovery: false,
                                    SystemBackup: false,
                                    SystemLogging: false,
                                    FirmwareUpgrade: false,
                                    SupportedVersions: { Major: 2, Minor: 5 },
                                    Extension: {
                                        HttpFirmwareUpgrade: false,
                                        HttpSystemBackup: false,
                                        HttpSystemLogging: false,
                                        HttpSupportInformation: false,
                                        Extension: {},
                                    },
                                },
                                IO: {
                                    InputConnectors: 0,
                                    RelayOutputs: 1,
                                    Extension: { Auxiliary: false, AuxiliaryCommands: '', Extension: {} },
                                },
                                Security: {
                                    'TLS1.1': false,
                                    'TLS1.2': false,
                                    OnboardKeyGeneration: false,
                                    AccessPolicyConfig: false,
                                    'X.509Token': false,
                                    SAMLToken: false,
                                    KerberosToken: false,
                                    RELToken: false,
                                    Extension: { 'TLS1.0': false, Extension: { Dot1X: false, RemoteUserHandling: false } },
                                },
                                Extension: {},
                            };
                        }

                        if (category === undefined || category === 'All' || category === 'Media') {
                            response.Capabilities.Media = {
                                XAddr: this.#mediaServiceUri(),
                                StreamingCapabilities: { RTPMulticast: false, RTP_TCP: true, RTP_RTSP_TCP: true, Extension: {} },
                                Extension: { ProfileCapabilities: { MaximumNumberOfProfiles: this.profiles.length } },
                            };
                        }

                        return response;
                    },

                    GetServices: () => ({
                        Service: [
                            {
                                Namespace: 'http://www.onvif.org/ver10/device/wsdl',
                                XAddr: this.#deviceServiceUri(),
                                Version: { Major: 2, Minor: 5 },
                            },
                            {
                                Namespace: 'http://www.onvif.org/ver10/media/wsdl',
                                XAddr: this.#mediaServiceUri(),
                                Version: { Major: 2, Minor: 5 },
                            },
                        ],
                    }),

                    GetDeviceInformation: () => ({
                        Manufacturer: 'Onvif',
                        Model: 'Cardinal',
                        FirmwareVersion: '1.0.0',
                        SerialNumber: `${slug(config.name)}-0000`,
                        HardwareId: `${slug(config.name)}-1001`,
                    }),
                },
            },

            MediaService: {
                Media: {
                    GetProfiles: () => ({ Profiles: this.profiles }),

                    GetVideoSources: () => ({ VideoSources: [this.videoSource] }),

                    GetAudioSources: () => ({ AudioSources: this.audio ? [this.audioSource] : [] }),

                    GetAudioSourceConfigurations: () => ({
                        Configurations: this.audio ? [this.audioSourceConfiguration] : [],
                    }),

                    GetAudioSourceConfiguration: () => {
                        if (!this.audio) throw noConfigFault('No audio source configured');
                        return { Configuration: this.audioSourceConfiguration };
                    },

                    GetAudioEncoderConfigurations: () => ({
                        Configurations: this.audio ? [this.audioEncoderConfiguration] : [],
                    }),

                    GetAudioEncoderConfiguration: () => {
                        if (!this.audio) throw noConfigFault('No audio encoder configured');
                        return { Configuration: this.audioEncoderConfiguration };
                    },

                    // The forwarded stream is fixed, so the only valid option is the
                    // configuration that is actually being delivered.
                    GetAudioEncoderConfigurationOptions: () => {
                        if (!this.audio) throw noConfigFault('No audio encoder configured');
                        return {
                            Options: {
                                Options: [{
                                    Encoding: this.audio.encoding,
                                    BitrateList: { Items: [this.audio.bitrate] },
                                    SampleRateList: { Items: [this.audio.samplerate] },
                                }],
                            },
                        };
                    },

                    GetSnapshotUri: (args) => {
                        let uri = `http://${config.hostname}:${config.ports.server}/snapshot.png`;

                        if (args?.ProfileToken === 'sub_stream' && config.lowQuality?.snapshot)
                            uri = `http://${config.hostname}:${config.ports.snapshot}${config.lowQuality.snapshot}`;
                        else if (config.highQuality.snapshot)
                            uri = `http://${config.hostname}:${config.ports.snapshot}${config.highQuality.snapshot}`;

                        return {
                            MediaUri: { Uri: uri, InvalidAfterConnect: false, InvalidAfterReboot: false, Timeout: 'PT30S' },
                        };
                    },

                    GetStreamUri: (args) => {
                        const streamPath = args?.ProfileToken === 'sub_stream' && config.lowQuality
                            ? config.lowQuality.rtsp
                            : config.highQuality.rtsp;

                        return {
                            MediaUri: {
                                Uri: `rtsp://${config.hostname}:${config.ports.rtsp}${streamPath}`,
                                InvalidAfterConnect: false,
                                InvalidAfterReboot: false,
                                Timeout: 'PT30S',
                            },
                        };
                    },
                },
            },
        };
    }

    /** Serves the placeholder snapshot. Bound as an arrow function so `this` survives. */
    #listen = (request, response) => {
        const { pathname } = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

        if (pathname === '/snapshot.png') {
            this.#snapshot ??= fs.readFileSync(SNAPSHOT_FILE);
            response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': this.#snapshot.length });
            response.end(this.#snapshot);
            return;
        }

        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('404 Not Found\n');
    };

    async startServer() {
        this.#server = http.createServer(this.#listen);

        // Without this, an EADDRINUSE anywhere kills the whole process.
        this.#server.on('error', (error) => {
            this.#logger.error(`http server error: ${error.message}`, { code: error.code });
        });

        await new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            this.#server.once('error', onError);
            this.#server.listen(this.#config.ports.server, this.#config.hostname, () => {
                this.#server.removeListener('error', onError);
                resolve();
            });
        });

        const device = this.#listenSoap('DeviceService', '/onvif/device_service', 'device_service.wsdl');
        const media = this.#listenSoap('MediaService', '/onvif/media_service', 'media_service.wsdl');
        this.#deviceService = device.service;
        this.#mediaService = media.service;

        // node-soap loads the WSDLs (and the Onvif schemas they import)
        // asynchronously and, if that fails, still installs its request
        // handler: every request then gets an HTTP 500 and nothing is logged.
        // Waiting here turns that silent state into a failed start.
        await Promise.all([device.ready, media.ready]);
    }

    #listenSoap(name, urlPath, wsdlFile) {
        let settle;
        const ready = new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`${name}: WSDL not loaded after ${WSDL_LOAD_TIMEOUT_MS / 1000} s`)),
                WSDL_LOAD_TIMEOUT_MS,
            );
            settle = (error) => {
                clearTimeout(timer);
                if (error) reject(new Error(`${name}: failed to load WSDL: ${error.message ?? error}`));
                else resolve();
            };
        });

        const service = soap.listen(this.#server, {
            path: urlPath,
            services: this.onvif,
            xml: fs.readFileSync(path.join(WSDL_DIR, wsdlFile), 'utf8'),
            forceSoap12Headers: true,
            wsdl_options: { overrideImportLocation: (includePath) => resolveImport(includePath) },
            callback: (error) => settle(error),
        });

        // Handler exceptions and faults are answered with HTTP 500 by node-soap;
        // without this they would never reach the log.
        const labels = { camera: this.#config.name, service: name };
        service.log = (type, data) => {
            if (type !== 'error') return;
            const message = data?.Fault?.Reason?.Text ?? data?.message ?? String(data);
            this.#logger.error(`${name} request failed: ${message}`);
            this.#metrics?.inc('onvif_server_soap_errors_total', 'SOAP requests answered with a fault or HTTP 500.', labels);
        };

        if (this.#metrics) {
            this.#metrics.inc('onvif_server_soap_errors_total', 'SOAP requests answered with a fault or HTTP 500.', labels, 0);
            service.on('request', (_request, method) => {
                this.#metrics.inc('onvif_server_soap_requests_total', 'SOAP requests by method.', { ...labels, method });
            });
        }

        return { service, ready };
    }

    enableDebugOutput() {
        this.#deviceService?.on('request', (_request, methodName) => {
            this.#logger.debug(`DeviceService: ${methodName}`);
        });
        this.#mediaService?.on('request', (_request, methodName) => {
            this.#logger.debug(`MediaService: ${methodName}`);
        });
    }

    #probeResponse(probeUuid) {
        return `<?xml version="1.0" encoding="UTF-8"?>
                        <SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
                            <SOAP-ENV:Header>
                                <wsa:MessageID>uuid:${randomUUID()}</wsa:MessageID>
                                <wsa:RelatesTo>${probeUuid}</wsa:RelatesTo>
                                <wsa:To SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:To>
                                <wsa:Action SOAP-ENV:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action>
                                <d:AppSequence SOAP-ENV:mustUnderstand="true" MessageNumber="${this.#discoveryMessageNo}" InstanceId="1234567890"/>
                            </SOAP-ENV:Header>
                            <SOAP-ENV:Body>
                                <d:ProbeMatches>
                                    <d:ProbeMatch>
                                        <wsa:EndpointReference>
                                            <wsa:Address>urn:uuid:${this.#config.uuid}</wsa:Address>
                                        </wsa:EndpointReference>
                                        <d:Types>dn:NetworkVideoTransmitter</d:Types>
                                        <d:Scopes>
                                            onvif://www.onvif.org/type/video_encoder
                                            onvif://www.onvif.org/type/ptz
                                            onvif://www.onvif.org/hardware/Onvif
                                            onvif://www.onvif.org/name/Cardinal
                                            onvif://www.onvif.org/location/
                                        </d:Scopes>
                                        <d:XAddrs>${this.#deviceServiceUri()}</d:XAddrs>
                                        <d:MetadataVersion>1</d:MetadataVersion>
                                    </d:ProbeMatch>
                                </d:ProbeMatches>
                            </SOAP-ENV:Body>
                        </SOAP-ENV:Envelope>`;
    }

    startDiscovery() {
        this.#discoveryMessageNo = 0;
        this.#discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.#discoverySocket.on('error', (error) => {
            this.#logger.error(`discovery socket error: ${error.message}`, { code: error.code });
        });

        this.#discoverySocket.on('message', (message, remote) => {
            this.#logger.debug(`discovery request from ${remote.address}:${remote.port}`);

            xml2js.parseString(
                message.toString(),
                { tagNameProcessors: [xml2js.processors.stripPrefix] },
                (error, result) => {
                    if (error) {
                        this.#logger.debug(`ignoring malformed discovery probe: ${error.message}`);
                        return;
                    }

                    let probeUuid;
                    let probeType = '';

                    try {
                        probeUuid = result.Envelope.Header[0].MessageID[0];
                    } catch {
                        this.#logger.debug('ignoring discovery probe without a MessageID');
                        return;
                    }

                    try {
                        probeType = result.Envelope.Body[0].Probe[0].Types[0];
                    } catch {
                        probeType = '';
                    }

                    if (typeof probeType === 'object') probeType = probeType._;
                    if (typeof probeUuid === 'object') probeUuid = probeUuid._;

                    if (probeType !== '' && !String(probeType).includes('NetworkVideoTransmitter')) return;

                    const response = Buffer.from(this.#probeResponse(probeUuid));
                    this.#discoveryMessageNo++;

                    // Reply on the existing socket. The original created a fresh
                    // dgram socket per probe and never closed it, leaking an fd
                    // on every discovery request.
                    this.#discoverySocket.send(response, 0, response.length, remote.port, remote.address, (sendError) => {
                        if (sendError) this.#logger.debug(`failed to answer discovery probe: ${sendError.message}`);
                    });
                },
            );
        });

        this.#discoverySocket.bind(DISCOVERY_PORT, () => {
            try {
                this.#discoverySocket.addMembership(DISCOVERY_GROUP, this.#config.hostname);
            } catch (error) {
                this.#logger.error(`failed to join discovery multicast group: ${error.message}`);
            }
        });
    }

    async close() {
        const closers = [];

        // Null the handles as we go: dgram.close() on an already-closed socket
        // throws, so a second close() must be a no-op rather than a surprise.
        const socket = this.#discoverySocket;
        this.#discoverySocket = undefined;
        if (socket) closers.push(new Promise((resolve) => socket.close(resolve)));

        const server = this.#server;
        this.#server = undefined;
        if (server) closers.push(new Promise((resolve) => server.close(resolve)));

        await Promise.allSettled(closers);
    }

    getHostname() {
        return this.#config.hostname;
    }

    /** The bound address, or null before startServer(). Useful when ports.server is 0. */
    address() {
        return this.#server?.address() ?? null;
    }
}

export function createServer(config, logger, options) {
    return new OnvifServer(config, logger, options);
}

export { getIpAddressFromMac, isDstObserved, standardTimezoneOffset, slug };
