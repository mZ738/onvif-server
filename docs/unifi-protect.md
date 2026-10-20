# Adopting in UniFi Protect

[← README](../README.md)

1. Enable discovery of third-party cameras in Protect.
2. Adopt the "Onvif Cardinal" devices. **This server does not check credentials** - any username and password are accepted. Restrict access to its ports by network or firewall.
3. Protect needs H.264, a high and a low profile, and a correct clock on the camera.

What Protect remembers:

- **The RTSP path is stored at adoption.** Changing `rtsp:` paths later has no effect until the camera is removed and adopted again - which creates a new device and empties its liveview slots.
- **Capabilities are re-read on reconnect.** Enabling audio only needed a restart of this server.
- **Protect keeps both profiles open permanently**, that is two RTSP sessions per camera. With a camera that struggles with sessions, point `highQuality` and `lowQuality` at the same stream (and declare the same resolution) to halve that.

