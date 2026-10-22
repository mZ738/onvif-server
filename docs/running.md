# Running

[← README](../README.md)

## Check before you restart

```bash
node main.js --check config.yaml     # or -t
```

Prints every virtual camera with its profiles, audio and discovery scopes, the planned forwarders and the state of the stored schemas; exits with 1 if the config would not start. It opens no port, so it can run next to a live instance - and as `ExecStartPre=` it keeps a broken config from replacing a working process.

## systemd

```ini
[Unit]
Description=Virtual Onvif Server
After=network-online.target
Wants=network-online.target

[Service]
ExecStartPre=/usr/bin/node /opt/onvif-server/main.js --check /etc/onvif-server/config.yaml
ExecStart=/usr/bin/node /opt/onvif-server/main.js /etc/onvif-server/config.yaml
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

The server exits non-zero when it cannot start (port in use, schema not loadable); `Restart=always` retries.

## Docker Compose

Run **one container per virtual camera**; Docker's macvlan driver gives each its own MAC and IP on your LAN. See [`docker-compose.yml`](../docker-compose.yml) and [`examples/config/`](../examples/config). Set `parent` to your LAN interface, `subnet`/`gateway` to your network and `ip_range` to addresses your DHCP server does not hand out.

```bash
docker compose up -d
```

The image stores the Onvif schemas at build time. With macvlan the Docker host itself cannot reach the containers; that does not matter when the NVR runs elsewhere.

Every release publishes a multi-arch image (amd64, arm64) to `ghcr.io/mz738/onvif-server`, tagged with the version (`2.1.1`), `major.minor` (`2.1`) and `latest`. Swap `build: .` for `image: ghcr.io/mz738/onvif-server:2.1` in the compose file to use it. See [CHANGELOG.md](../CHANGELOG.md) for what each release contains.

To generate a config inside the container:

```bash
docker compose run --rm --entrypoint node front-door main.js --create-config
```

## Without Docker: one address per camera

On a plain Linux host, give every virtual camera an address with a macvlan interface:

```bash
sudo ip link add onvif-1 link eth0 address a2:a2:a2:a2:a2:a1 type macvlan mode bridge
sudo ip link set onvif-1 up
```

Use [locally administered MAC addresses](https://en.wikipedia.org/wiki/MAC_address#Universal_vs._local_(U/L_bit)) and reserve the IPs in your DHCP server. These interfaces do not survive a reboot unless you add them to your network configuration (systemd-networkd, ifupdown or NetworkManager).

The MAC address itself is never sent to the NVR. What matters is a separate IP per virtual camera; `mac:` in the config is only a way to find that IP.

## Starting without internet access

The WSDLs import the official Onvif schemas, which import OASIS and W3C schemas - about a dozen files on three hosts. Without a local copy they are downloaded on every start, and if one download fails the server stops with:

```
failed to load WSDL: getaddrinfo EAI_AGAIN www.onvif.org
```

`npm run vendor-schemas` stores them unmodified under `wsdl/vendor/` with a `SHA256SUMS` file; the server uses them from then on, and `--check` verifies them. Run it again after updating this server.

