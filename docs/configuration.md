# Configuration

[← README](../README.md)

One file, a list of virtual cameras under `onvif:` and optional `mqtt:` and `metrics:` blocks.

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
    motion:                                        # optional, see Motion events
      topic: frigate/front_door/motion
    target:
      hostname: 192.168.1.152                      # the real camera, recorder or go2rtc
      ports:
        rtsp: 554
        snapshot: 80                               # optional

mqtt:                                              # needed for motion, see Motion events
  url: mqtt://192.168.1.10:1883

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
| `motion` | no | MQTT topic that reports motion, see [Motion events](#motion-events) |
| `target.hostname`, `target.ports` | yes | Where RTSP and snapshot connections are forwarded to |
| `mqtt.url` | with `motion` | Broker, `mqtt://`, `mqtts://`, `ws://` or `wss://` |
| `mqtt.username`, `mqtt.clientId` | no | Broker login; the password comes from the `MQTT_PASSWORD` environment variable |
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

## Motion events

The virtual camera cannot see motion itself, so it takes it from MQTT and passes it on as Onvif events (PullPoint). UniFi Protect 7.1.55 and later shows them as motion events on the timeline and can trigger recordings with them - see [UniFi Protect](unifi-protect.md#motion-events).

```yaml
onvif:
  - name: Front Door
    # ...
    motion:
      topic: frigate/front_door/motion   # one topic, no wildcards
      payloadOn: "ON"                    # default "ON"
      payloadOff: "OFF"                  # default "OFF"
      resetAfter: 60                     # optional, seconds

mqtt:
  url: mqtt://192.168.1.10:1883
  username: onvif                        # optional
  clientId: onvif-server                 # optional, default onvif-server-<pid>
```

- **Sources:** anything that publishes a fixed "on" and "off" payload on one topic. [Frigate](https://docs.frigate.video/integrations/mqtt/) publishes `frigate/<camera>/motion` with `ON`/`OFF` (defaults here). A Home Assistant binary sensor sent to MQTT usually uses `on`/`off` - set `payloadOn`/`payloadOff`. Payloads are compared exactly, after trimming whitespace; quote them in YAML.
- **`resetAfter`** ends motion that many seconds after the last "on". Use it for sources that only report the start of motion, and as a safety net against a lost "off".
- **Password:** set `MQTT_PASSWORD` in the environment (systemd `Environment=`/`EnvironmentFile=`, Compose `environment:`). A password in the config or in the URL is rejected.
- **Broker down:** the server starts anyway and keeps reconnecting every 5 s. While disconnected, every camera reports "no motion", so a recording cannot hang on a stale "on".
- Without `motion:` a camera offers no event service at all, as before.

What is published, for clients that look closely:

| Topic | Data | Source |
|---|---|---|
| `tns1:RuleEngine/CellMotionDetector/Motion` | `IsMotion` | `VideoSourceConfigurationToken`, `VideoAnalyticsConfigurationToken`, `Rule` |
| `tns1:VideoSource/MotionAlarm` | `State` | `Source` (video source token) |

Both are properties: a new subscription first receives the current state (`Initialized`), then every change (`Changed`). Subscriptions are limited to 10 per camera (the oldest makes room) and live for at most an hour without a pull or renew; a pull keeps a subscription alive. Topic filters are honoured, message content filters are not (a client using them gets every message). Push subscriptions (`wsnt:Subscribe`) are not offered.

## Metrics

With a `metrics:` block the server serves `GET /metrics` in the Prometheus text format:

| Metric | Labels | Meaning |
|---|---|---|
| `onvif_server_proxy_connections` | `listen`, `target` | Open client connections |
| `onvif_server_proxy_connections_total` | `listen`, `target` | Connections accepted |
| `onvif_server_proxy_bytes_total` | `listen`, `target`, `direction` | Bytes forwarded; `to_client` is camera → NVR |
| `onvif_server_proxy_last_transfer_timestamp_seconds` | `listen`, `target`, `direction` | Unix time of the last forwarded data |
| `onvif_server_proxy_max_idle_seconds` | `listen`, `target`, `direction` | Longest time any single open connection went without data; 0 without connections |
| `onvif_server_soap_requests_total` | `camera`, `service`, `method` | Onvif requests |
| `onvif_server_soap_errors_total` | `camera`, `service` | Requests answered with a fault or HTTP 500 |
| `onvif_server_motion_active` | `camera` | Motion state passed to event subscribers (1 = motion) |
| `onvif_server_event_subscriptions` | `camera` | Open Onvif event subscriptions - 0 means the NVR does not listen for motion |
| `onvif_server_mqtt_connected` | | 1 while the motion input is connected to the broker |
| `onvif_server_build_info` | `version` | Constant 1 |

A frozen picture - which NVRs often keep reporting as "connected" - shows up as an open connection whose `to_client` data has stopped. NVRs often keep several sessions per camera open, so use the per-connection `max_idle_seconds` rather than the byte counters, which keep growing as long as any one session flows:

```yaml
- alert: OnvifStreamFrozen
  expr: onvif_server_proxy_max_idle_seconds{direction="to_client"} > 30
  for: 1m
```

