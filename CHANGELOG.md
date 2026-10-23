# Changelog

Versions follow [Semantic Versioning](https://semver.org/). Releases are cut with `npm version <major|minor|patch>` and `git push --follow-tags`; the [Release workflow](.github/workflows/release.yml) then runs the tests, publishes the image to `ghcr.io/mz738/onvif-server` and creates the GitHub release.

## [2.1.2] - 2026-10-23

### Added

- `manufacturer` and `model` per camera: what `GetDeviceInformation` and the discovery scopes report, so an NVR offers the camera under a name of your choosing instead of "Onvif Cardinal". Defaults unchanged.

## [2.1.1] - 2026-10-22

### Fixed

- `npm run vendor-schemas` left `wsdl/vendor/` readable only for the user who ran it (the staging directory comes from `mkdtemp`, 0700). A server running under its own user then reported `schemas not vendored` and fetched the schemas from the internet on every start. Directories are now 0755 and files 0644 ([#6](https://github.com/mZ738/onvif-server/issues/6)).

### Added

- A weekly workflow watches Ubiquiti's UniFi Protect release notes and opens an issue when a release mentions third-party cameras.
- Docs: a camera adopted before `motion:` existed must be adopted again; one MAC per camera IP also applies to veth setups.

## [2.1.0] - 2026-10-22

First release of this fork. Everything below is on top of davidcoulson/onvif-server 2.0.0.

### Added

- **Motion events** (`motion:` per camera, `mqtt:` block): an Onvif PullPoint event service fed from one MQTT topic per camera, with `resetAfter` as a safety net. UniFi Protect 7.1.55+ turns these into motion events - a camera adopted earlier has to be adopted again. The broker password comes from `MQTT_PASSWORD`, never from the config file.
- **Audio** (`audio:`): the audio track is advertised in the Onvif profiles; Protect shows the microphone.
- **Prometheus metrics** (`metrics:`): connections, bytes, SOAP requests and errors, event subscriptions, motion state, MQTT state, and `onvif_server_proxy_max_idle_seconds` per forwarded connection for a stall watchdog.
- **`--check` / `-t`**: validates the configuration and the local schemas without opening a port; usable as `ExecStartPre=`.
- **Starting without internet**: `npm run vendor-schemas` stores the Onvif/OASIS/W3C schema chain locally; the server loads it from there.
- **Protect 7.2 calls**: encoder options and configuration (reported, not changeable), time and NTP calls.
- **Docs** under `docs/`: configuration, running, adopting in UniFi Protect with feature support per Protect version, troubleshooting.

### Changed

- One TCP forwarder per address *and* port (upstream only listened on the last camera's address).
- The server fails loudly when the WSDL cannot be loaded instead of answering HTTP 500 forever.
- TCP keepalive on forwarded connections; the WS-Discovery `InstanceId` grows with every start; one discovery socket instead of one per probe.
- `follow-redirects` updated (GHSA-q3jh-wrc6-jgq8, GHSA-8r9p-f939-6h3c).

[2.1.2]: https://github.com/mZ738/onvif-server/releases/tag/v2.1.2
[2.1.1]: https://github.com/mZ738/onvif-server/releases/tag/v2.1.1
[2.1.0]: https://github.com/mZ738/onvif-server/releases/tag/v2.1.0
