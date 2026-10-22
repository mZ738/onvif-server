# Adopting in UniFi Protect

[← README](../README.md)

1. Enable discovery of third-party cameras in Protect.
2. Adopt the "Onvif Cardinal" devices. **This server does not check credentials** - any username and password are accepted. Restrict access to its ports by network or firewall.
3. Protect needs H.264, a high and a low profile, and a correct clock on the camera.

What Protect remembers:

- **The RTSP path is stored at adoption.** Changing `rtsp:` paths later has no effect until the camera is removed and adopted again - which creates a new device and empties its liveview slots.
- **Capabilities are re-read on reconnect.** Enabling audio only needed a restart of this server.
- **Protect keeps both profiles open permanently**, that is two RTSP sessions per camera. With a camera that struggles with sessions, point `highQuality` and `lowQuality` at the same stream (and declare the same resolution) to halve that.


## Encoding and time settings

From Protect 7.2 on, Protect manages recording/encoding settings and the clock of third-party cameras centrally. The virtual camera forwards the real stream unchanged and reports the host's clock, so:

- **Encoder options** list exactly the configured stream (resolution, frame rate, bitrate). A `SetVideoEncoderConfiguration` that asks for those values is accepted; any other value is refused with the Onvif fault `ter:ConfigModify`, and the log names the field (`client tried to change the encoder, ...`). Change such settings on the real camera (or in go2rtc) and then in the config.
- **Time** comes from the host. `SetSystemDateAndTime` with NTP is accepted; a manual time is accepted only within 5 s of the host clock - otherwise the log shows how far apart they are. `SetNTP` is stored and reported back by `GetNTP` but **not applied**: synchronise the host itself (chrony, systemd-timesyncd), preferably with the same NTP server Protect hands out.
