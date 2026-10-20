# Configuration

[← README](../README.md)

One file, a list of virtual cameras under `onvif:` and an optional `metrics:` block.

```yaml
onvif:
  - name: Front Door                               # shown in the NVR
    uuid: 1714a629-ebe5-4bb8-a430-c18ffd8fa5f6     # unique per camera, any UUIDv4
    hostname: 192.168.1.241                        # address this virtual camera listens on
    ports:
      server: 8081                                 # Onvif SOAP
      rtsp: 8554                                   # forwarded to target.ports.rtsp
      snapshot: 8580                               # forwarded to target.ports.snapshot (optional)
    highQuality:
      rtsp: /cam/realmonitor?channel=1&subtype=0   # path on the target
      snapshot: /onvif/snapshot                    # optional
      width: 2560
      height: 1440
      framerate: 20
      bitrate: 4096                                # kbit/s
      quality: 4
    lowQuality:                                    # optional, same keys; quality: 1
      rtsp: /cam/realmonitor?channel=1&subtype=1
      width: 640
      height: 360
      framerate: 15
      bitrate: 512
      quality: 1
    audio: true                                    # optional, see Audio
    target:
      hostname: 192.168.1.152                      # the real camera, recorder or go2rtc
      ports:
        rtsp: 554
        snapshot: 80                               # optional

metrics:                                           # optional, see Metrics
  port: 9180
```

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | Display name; spaces are fine |
| `uuid` | yes | Identifies the device in discovery. Keep it stable - a new UUID looks like a new camera |
| `hostname` or `mac` | one of them | Address to listen on. `mac` looks up the local interface with that MAC instead |
| `ports.server`, `ports.rtsp` | yes | Each virtual camera needs its own address; ports may repeat across addresses |
| `ports.snapshot` | no | Without it the NVR gets a placeholder image |
| `highQuality`, `lowQuality` | high: yes | What is advertised. Use the real values of the stream - clients cache them |
| `audio` | no | `true` or a mapping, see [Audio](#audio) |
| `target.hostname`, `target.ports` | yes | Where RTSP and snapshot connections are forwarded to |
| `metrics.port`, `metrics.host` | no | Enables `/metrics`; `host` defaults to `0.0.0.0` |

Credentials do not belong in the config. RTSP URLs with a user and password are entered in the NVR (or configured in go2rtc), not here.

## Wrapping a plain RTSP stream

Split the URL into host, port and path:

```
rtsp://192.168.1.32:554/cam/stream
       └─ hostname ─┘└┬┘└─ path ──┘
                    port (default 554)
```

Then fill in `target.hostname`, `target.ports.rtsp` and `highQuality.rtsp`. Resolution, frame rate and bitrate can be read with `ffprobe` or in VLC (*Window → Media Information*). Without a separate low-quality stream, copy `highQuality` to `lowQuality` and set `quality: 1`.

## Audio

The audio track already passes through the RTSP forwarder. Without advertising it, clients such as UniFi Protect treat the camera as having no microphone.

```yaml
    audio: true            # AAC, 64 kbit/s, 16 kHz, mono
```

or describe the actual stream:

```yaml
    audio:
      encoding: AAC        # G711, G726 or AAC
      bitrate: 64          # kbit/s
      samplerate: 16       # kHz - not Hz
      channels: 1
```

Check the real values first, for example `ffprobe -select_streams a rtsp://...`. In UniFi Protect the microphone appeared a few minutes after the server was restarted with audio enabled - without re-adopting the camera. Two-way audio (talk back) is not supported.

## Metrics

With a `metrics:` block the server serves `GET /metrics` in the Prometheus text format:

| Metric | Labels | Meaning |
|---|---|---|
| `onvif_server_proxy_connections` | `listen`, `target` | Open client connections |
| `onvif_server_proxy_connections_total` | `listen`, `target` | Connections accepted |
| `onvif_server_proxy_bytes_total` | `listen`, `target`, `direction` | Bytes forwarded; `to_client` is camera → NVR |
| `onvif_server_proxy_last_transfer_timestamp_seconds` | `listen`, `target`, `direction` | Unix time of the last forwarded data |
| `onvif_server_soap_requests_total` | `camera`, `service`, `method` | Onvif requests |
| `onvif_server_soap_errors_total` | `camera`, `service` | Requests answered with a fault or HTTP 500 |
| `onvif_server_build_info` | `version` | Constant 1 |

A frozen picture - which NVRs often keep reporting as "connected" - shows up as an open connection whose `to_client` data has stopped:

```yaml
- alert: OnvifStreamFrozen
  expr: |
    onvif_server_proxy_connections > 0
    and on (listen, target)
    time() - onvif_server_proxy_last_transfer_timestamp_seconds{direction="to_client"} > 30
  for: 1m
```

