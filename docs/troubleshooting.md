# Troubleshooting

[← README](../README.md)

## All cameras show the same picture

Protect tells cameras apart by MAC address. If your host answers ARP for all macvlan addresses with one MAC, set ([background](https://serverfault.com/questions/682311/virtual-interfaces-with-different-mac-addresses)):

```bash
sudo sysctl -w net.ipv4.conf.all.arp_ignore=1
sudo sysctl -w net.ipv4.conf.all.arp_announce=2
```

## Only snapshots, no live video

The camera may have reached its limit of concurrent RTSP sessions, or it does not deliver H.264. See the next entry.

## Cameras reboot or freeze when several clients watch

Many consumer cameras handle only a few simultaneous RTSP sessions, and NVRs, home automation, object detection and phone apps each open their own. Observed with Reolink cameras: reboots (on PTZ models visible as the calibration sweep at boot), frozen pictures and dropped sessions after adding them to an NVR directly. We did not prove the session count as the cause, but the fix removes the variable:

- Put **go2rtc** in front and point *every* consumer, including this server's `target`, at go2rtc. go2rtc pulls on demand and holds **one session per camera stream** no matter how many clients watch.
- Point both Onvif profiles at the same go2rtc stream (see [Adopting](unifi-protect.md)).
- Check for hidden consumers. A video tool's prebuffer (Scrypted, for example) can keep its own sessions to the camera open - in one case doubling the camera's upload and adding 20-25 points of camera CPU.

## The NVR says "connected", but the picture is frozen

UniFi Protect kept reporting a third-party camera as connected through more than a minute without a single new frame; only the burned-in timestamp gave it away. Watch the data, not the connection state: [`onvif_server_proxy_last_transfer_timestamp_seconds`](configuration.md#metrics), or go2rtc's byte counters.

If the camera itself stalls (Wi-Fi), go2rtc reconnects on its own in roughly 20-40 s. **Do not** kick the consumers in that case - forcing disconnects interrupted go2rtc's own recovery and made it slower (>70 s instead of ~36 s). Intervening helps only when the camera side is fine and the stream stops on the way to the NVR.

## Wi-Fi cameras drop out

- Measure the link, not just the signal: a camera with good signal strength showed a 34 % Wi-Fi retry rate on a crowded 2.4 GHz channel; on another access point it dropped to under 3 %.
- Sampling a ping once per minute misses outages of 40-50 s. In Prometheus use `min_over_time(probe_success[5m])` rather than single samples.
- Several "reboots" turned out to be packet loss with the Wi-Fi link up; a real reboot of a PTZ model shows the calibration sweep.
- Check the camera's scheduled automatic reboot (Reolink: *Auto Reboot*), it is a common cause of daily restarts.

## Audio is missing

Add [`audio:`](configuration.md#audio) to the camera and restart. Without it the stream's audio is delivered but not advertised.

## No motion events

Work through the chain with the [metrics](configuration.md#metrics) or `--debug`:

1. `onvif_server_mqtt_connected` is 0: broker address, login (`MQTT_PASSWORD` set for the process?) or firewall. The log says why.
2. `onvif_server_motion_active` never changes: the topic or the payloads do not match. `mosquitto_sub -v -t 'frigate/#'` shows what is actually published; with `--debug` the server logs payloads it ignores.
3. `onvif_server_event_subscriptions` is 0: the NVR does not subscribe. UniFi Protect needs 7.1.55 or later. Protect re-reads a camera's capabilities on reconnect (observed for audio), so restart this server once after adding `motion:`; if that is not enough, reconnect the camera in Protect.
4. Motion is reported, but Protect still shows no events: check the camera's motion/recording settings in Protect. Protect's handling of third-party events is not documented in detail; please report what you see.

## Every request returns HTTP 500, or the server does not start

`failed to load WSDL` in the log means the Onvif schemas could not be downloaded - see [Starting without internet access](running.md#starting-without-internet-access). Older versions did not log this and kept answering HTTP 500 until restarted.

## `Wsse authorized time check failed`

Set the clock of the real Onvif device to the correct time.

## Reolink notes

- Some models (E1 Pro, for example) have **no web interface**; port 80 answers 403. Manage them with the Reolink app or desktop client. The HTTP API (`/api.cgi`) is available when "HTTP server" is enabled.
- The HTTP API has a **small global session limit**; a login without logout holds a slot for about an hour. A burst of several dozen API requests made one camera fail with HTTP 502 and reboot. Read settings through an integration that polls anyway, or use one session, few requests with pauses, and always log out.
- Substreams took noticeably longer to start than main streams (1-5 s more each) - relevant if a tool aborts slow stream starts.
- Cameras contact the vendor cloud continuously (UDP 9999) and may open ports via UPnP. Disable UPnP on the camera and restrict it on the router.

