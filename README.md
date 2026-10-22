# Virtual Onvif Server

[![CI](https://github.com/mZ738/onvif-server/actions/workflows/ci.yml/badge.svg)](https://github.com/mZ738/onvif-server/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/mZ738/onvif-server?sort=semver)](https://github.com/mZ738/onvif-server/releases)

Turns an RTSP stream into a virtual Onvif camera, so NVRs that only accept Onvif devices - UniFi Protect in particular - can record and show it. It also splits multi-channel recorders (Dahua/Hikvision XVRs, multi-lens cameras) into one virtual camera per channel.

The server answers the Onvif requests itself and forwards RTSP and snapshot traffic unchanged to the real source. It implements Onvif Profile S (live streaming) and, optionally, motion events fed from MQTT; there is no PTZ and no authentication.

> [!NOTE]
> This is a fork of [davidcoulson/onvif-server](https://github.com/davidcoulson/onvif-server), which modernized the original [daniela-hase/onvif-server](https://github.com/daniela-hase/onvif-server) (see [MODERNIZATION.md](MODERNIZATION.md)). What this fork adds is listed [below](#what-this-fork-adds).

## How it works

```
camera ──RTSP──▶ go2rtc (recommended) ──RTSP──▶ virtual Onvif device ──Onvif + RTSP──▶ NVR
                                                (this server)
```

- Each virtual camera gets **its own IP address** and answers Onvif discovery and SOAP requests there.
- RTSP and snapshot connections to that address are forwarded byte for byte to `target`. Nothing is transcoded.
- Putting [go2rtc](https://github.com/AlexxIT/go2rtc) between the camera and *all* consumers is strongly recommended for consumer cameras: the camera then holds one session, however many consumers there are (see [troubleshooting](docs/troubleshooting.md#cameras-reboot-or-freeze-when-several-clients-watch)).

## What this fork adds

| | |
|---|---|
| **Audio** | Advertises the stream's audio track, so the NVR offers sound ([Audio](docs/configuration.md#audio)) |
| **Motion events** | Motion from MQTT (Frigate, Home Assistant, ...) is passed on as Onvif events, which UniFi Protect 7.1.55+ shows and records ([Motion events](docs/configuration.md#motion-events)) |
| **Protect 7.2 settings** | Encoder and time requests are answered instead of failing with HTTP 500 ([details](docs/unifi-protect.md#encoding-and-time-settings)) |
| **Starts without internet** | The imported Onvif/OASIS/W3C schemas can be stored locally; a failed schema download now stops the start with a clear message instead of leaving a server that answers HTTP 500 ([details](docs/running.md#starting-without-internet-access)) |
| **`--check`** | Validates a config and shows what would be served, without opening a port ([Check before you restart](docs/running.md#check-before-you-restart)) |
| **Metrics** | Optional Prometheus endpoint with per-forwarder traffic and "last data" timestamps - detects frozen streams the NVR still reports as connected ([Metrics](docs/configuration.md#metrics)) |
| **Forwarder fix** | Several virtual cameras using the same port on different addresses each get their forwarder (previously only the last one did) |
| **TCP keepalive** | Dead NVR connections are detected after seconds, not minutes |
| **Accurate capabilities** | No PTZ scope without PTZ, no phantom relay output, `Multicast` element where the Onvif schema requires it |

## Quick start

Requirements: **Node.js 24+**, one free IP address per virtual camera on the NVR's network, and an H.264 source.

```bash
git clone https://github.com/mZ738/onvif-server.git
cd onvif-server
git checkout v2.1.1             # a release tag; main is the development branch
npm ci --omit=dev
npm run vendor-schemas          # store the Onvif schemas locally (needs internet once)

cp examples/config/front-door.yaml config.yaml   # then edit, see docs/configuration.md
node main.js --check config.yaml                 # dry run
node main.js config.yaml
```

The virtual cameras then show up for adoption in UniFi Protect as **"Onvif Cardinal"**. See [Adopting in UniFi Protect](docs/unifi-protect.md).

Releases are listed in [CHANGELOG.md](CHANGELOG.md); each one also publishes a container image, `ghcr.io/mz738/onvif-server` (see [Docker Compose](docs/running.md#docker-compose)).

To generate a config from a real Onvif camera or recorder instead:

```bash
node main.js --create-config
```

## Documentation

| | |
|---|---|
| [Configuration](docs/configuration.md) | All keys, wrapping a plain RTSP stream, audio, motion events, metrics |
| [Running](docs/running.md) | `--check`, systemd, Docker Compose, one address per camera, starting without internet |
| [UniFi Protect](docs/unifi-protect.md) | Adoption, credentials, what Protect remembers, feature support by version |
| [Troubleshooting](docs/troubleshooting.md) | Frozen pictures, rebooting cameras, Wi-Fi drop-outs, HTTP 500, Reolink notes |
| [CHANGELOG](CHANGELOG.md) | What each release contains, how releases are cut |

## Development

```bash
npm ci
npm test            # stores the schemas first (pretest), then runs node --test
```

| Path | Content |
|---|---|
| `main.js` | CLI, startup, shutdown |
| `src/onvif-server.js` | Onvif device and media services, discovery |
| `src/event-service.js`, `src/mqtt-motion.js` | Onvif events (PullPoint), motion input from MQTT |
| `src/tcp-proxy.js`, `src/forwards.js` | RTSP/snapshot forwarding |
| `src/metrics.js`, `src/check.js`, `src/config-schema.js` | Metrics, `--check`, config validation |
| `scripts/vendor-schemas.js` | Local copy of the imported schemas |

Issues and pull requests are welcome.

## Credits and license

Originally written by Daniela Hasenbring ([daniela-hase/onvif-server](https://github.com/daniela-hase/onvif-server)), modernized by David Coulson ([davidcoulson/onvif-server](https://github.com/davidcoulson/onvif-server)). MIT licensed, see [LICENSE](LICENSE).
