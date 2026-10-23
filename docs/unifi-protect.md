# Adopting in UniFi Protect

[← README](../README.md)

## Steps

1. Enable discovery of third-party cameras in Protect.
2. Adopt the devices - offered as "Onvif Cardinal", or as the `manufacturer`/`model` you set per camera. **This server does not check credentials** - any username and password are accepted. Restrict access to its ports by network or firewall.
3. Protect needs H.264, a high and a low profile, and a correct clock on the camera.

## Feature support by Protect version

What UniFi Protect offers third-party (Onvif) cameras, and what this server makes of it. Compiled from Ubiquiti's release notes and announcements as of October 2026; Ubiquiti's own help pages partly contradict each other, so treat the Protect column as a guide, not a guarantee. A [weekly workflow](../.github/workflows/protect-watch.yml) reads Ubiquiti's release feed and opens an issue when a release mentions third-party cameras; the lines it has seen are in [`docs/watch/protect-releases.json`](watch/protect-releases.json).

| Feature | Protect | This server |
|---|---|---|
| Live view, recording | 5.0.33+ | yes |
| Audio (microphone) | 7.1.55+ | yes, with [`audio:`](configuration.md#audio) |
| Motion events | 7.1.55+ | yes, from MQTT with [`motion:`](configuration.md#motion-events) |
| Detects configuration changes on the camera | 7.1.55+ | profiles are fixed; changes take a restart (see below) |
| Encoding settings managed from Protect | 7.2+ | reported, not changeable - see [Encoding and time settings](#encoding-and-time-settings) |
| Time server sync | 7.2+ | accepted, the host clock is used - see [Encoding and time settings](#encoding-and-time-settings) |
| I/O relays as automation triggers | 7.2+ | no - the virtual camera has no inputs or relays |
| PTZ | documented as supported, partly only with an AI Port | no |
| Two-way audio (talk back) | not documented for third-party cameras | no |
| Smart detections (person, vehicle, face, licence plate) | only with an [AI Port](#ai-port) | indirectly - the AI Port analyses the forwarded stream |
| H.265 | not documented for third-party cameras | advertised as H.264 only (Onvif Media 1) |

### AI Port

An AI Port adds Protect's smart detections to third-party cameras by analysing their stream. According to Ubiquiti's AI Port FAQ it handles **one 4K, up to two 2K or up to three HD** third-party cameras, up to 30 fps; third-party and UniFi cameras cannot share one port, and changing a camera's streams requires re-adopting it. It picks the highest and lowest resolution profile as HQ/LQ - declare the real resolutions in `highQuality`/`lowQuality`, they decide how many cameras one port takes.

## Adoption

What Protect remembers:

- **The RTSP path is stored at adoption.** Changing `rtsp:` paths later has no effect until the camera is removed and adopted again - which creates a new device and empties its liveview slots.
- **Capabilities are re-read on reconnect.** Enabling audio only needed a restart of this server.
- **Protect keeps both profiles open permanently**, that is two RTSP sessions per camera. With a camera that struggles with sessions, point `highQuality` and `lowQuality` at the same stream (and declare the same resolution) to halve that.

## Encoding and time settings

From Protect 7.2 on, Protect manages recording/encoding settings and the clock of third-party cameras centrally. The virtual camera forwards the real stream unchanged and reports the host's clock, so:

- **Encoder options** list exactly the configured stream (resolution, frame rate, bitrate). A `SetVideoEncoderConfiguration` that asks for those values is accepted; any other value is refused with the Onvif fault `ter:ConfigModify`, and the log names the field (`client tried to change the encoder, ...`). Change such settings on the real camera (or in go2rtc) and then in the config.
- **Time** comes from the host. `SetSystemDateAndTime` with NTP is accepted; a manual time is accepted only within 5 s of the host clock - otherwise the log shows how far apart they are. `SetNTP` is stored and reported back by `GetNTP` but **not applied**: synchronise the host itself (chrony, systemd-timesyncd), preferably with the same NTP server Protect hands out.

## Motion events

Since Protect 7.1.55, third-party cameras can deliver motion through Onvif events. With [`motion:`](configuration.md#motion-events) the virtual camera offers an event service and passes on motion it receives over MQTT, for example from Frigate running on the same stream.

- **A camera adopted before `motion:` was configured has to be removed and adopted again.** Protect decides at adoption whether a third-party camera can report motion. Afterwards it still subscribes to the event service (`onvif_server_event_subscriptions` goes to 1, PullMessages arrive every few seconds) but ignores every notification, and its settings show no event section. Verified on Protect 7.2: no events before re-adoption, event settings and timeline events right after it. Audio was the exception - Protect picked that up on reconnect.
- Protect subscribes on its own: per camera it creates a PullPoint subscription (`InitialTerminationTime PT60S`), pulls every 5 s (`Timeout PT2S`, `MessageLimit 10`), renews once and re-subscribes every 60 s after re-reading the profiles. A gauge that briefly reads 0 between Unsubscribe and the next CreatePullPointSubscription is normal.
- **These are plain motion events, whatever triggered them.** Protect receives "motion on/off" and nothing else - a person, a package or a crying baby published to the same topic all show up as motion, and several sources on one topic merge into one state. Protect's smart detections (person, vehicle, ...) on third-party cameras need an AI Port - see [Feature support](#feature-support-by-protect-version). To keep events meaningful, publish only the source that matters, or use one virtual camera per source.
- Not verified: which of the two published topics Protect evaluates. Both are sent, as Hikvision-family cameras do.
