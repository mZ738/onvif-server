# Modernization notes (v2.0.0)

> These notes describe the modernization done in
> [davidcoulson/onvif-server](https://github.com/davidcoulson/onvif-server).
> The statement below that wire behaviour is unchanged applies to that step;
> later changes in this fork (audio, capabilities, discovery scopes) are listed
> in the [README](README.md#what-this-fork-adds).

This fork targets **Node 24+** and trims the dependency tree by moving to the
standard library. Behaviour on the wire is unchanged — the Onvif responses,
WS-Discovery payload and config format are byte-for-byte compatible with v1, so
existing `config.yaml` files keep working.

## Bugs fixed

| Issue | Detail |
| --- | --- |
| **fd leak in WS-Discovery** | Every probe response called `dgram.createSocket('udp4').send(...)` and never closed the socket. UniFi Protect probes continuously, so the process leaked a descriptor per probe until it hit the fd limit. Responses now go out on the already-bound discovery socket. |
| **CWD-relative resource loading** | `./wsdl/*.wsdl` and `./resources/snapshot.png` were read relative to the working directory, so the app only ran when started from its own folder. Now resolved from `import.meta.dirname`. |
| **Unbound request handler** | `http.createServer(this.listen)` lost `this`. Harmless only because the handler never touched it. Now a bound class field. |
| **Partial space replacement** | `name.replace(' ', '_')` replaced only the first space, so multi-word camera names produced malformed `SerialNumber` / `HardwareId`. Now `replaceAll`. |
| **Fatal `EADDRINUSE`** | A port conflict on one camera threw an unhandled `error` event and killed every other camera in the process. Startup failures are now reported per camera and shut the rest down cleanly. |
| **Permanent `Date.prototype` mutation** | The config builder's clock-skew retry overwrote `Date.prototype.getUTCHours` for the life of the process. The patch is now scoped to the retry and restored in a `finally`. |
| **`Date.prototype` monkey-patching** | `stdTimezoneOffset` / `isDstObserved` were added to the global prototype. Now plain module functions. |

## Security

- **`xml2js` 0.4.23 → 0.6.2.** 0.4.x is vulnerable to prototype pollution
  (CVE-2023-0842), and it parses unauthenticated multicast discovery probes, so
  the path was reachable from anything on the LAN.
- **`package-lock.json` is now committed** (it was in `.gitignore`), so the image
  builds with `npm ci` and is reproducible.
- The container runs as the non-root `node` user.

## Dependencies: 7 → 3

| Removed | Replaced by |
| --- | --- |
| `node-uuid` (deprecated since 2016) | `crypto.randomUUID()` |
| `argparse` | `util.parseArgs` |
| `node-tcp-proxy` (0.0.x, unmaintained) | `src/tcp-proxy.js` on `node:net` |
| `simple-node-logger-se` | `src/logger.js` on `util.styleText` |

Remaining: `soap`, `xml2js`, `yaml`.

## Architecture

- **ESM throughout** (`"type": "module"`).
- **Config validation** (`src/config-schema.js`) — every problem in the file is
  reported at once with its exact path, instead of surfacing later as an opaque
  `TypeError` from inside the SOAP layer. It also catches two cameras configured
  on the same host and port.
- **Structured logging** — per-camera child loggers, and `LOG_FORMAT=json` emits
  newline-delimited JSON for log shippers.
- **Graceful shutdown** — `SIGTERM`/`SIGINT` close the HTTP servers, discovery
  sockets and in-flight proxy connections, which matters under Docker.
- **Tests** — 31 tests under `node:test`, run with `npm test`.
- **CI** — tests on Node 24 and 26, `npm audit`, and a Docker build.

## Running

```bash
npm ci
node main.js /path/to/config.yaml

# generate a config by probing a real camera
node main.js --create-config
```

```bash
docker build -t onvif-server .
docker run --rm -it --net=host -v /path/to/config.yaml:/onvif.yaml onvif-server
```
