import http from 'node:http';

/**
 * A minimal Prometheus registry - counters and gauges with labels, rendered in
 * the text exposition format. Small enough not to justify a dependency.
 */
export class Metrics {
    #families = new Map();
    #collectors = [];

    /** Registers a function that updates values right before every render, for values that change without events (durations). */
    collect(fn) {
        this.#collectors.push(fn);
    }

    #family(name, type, help) {
        let family = this.#families.get(name);
        if (!family) {
            family = { type, help, series: new Map() };
            this.#families.set(name, family);
        }
        return family;
    }

    #series(name, type, help, labels) {
        const family = this.#family(name, type, help);
        const key = JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
        let series = family.series.get(key);
        if (!series) {
            series = { labels, value: 0 };
            family.series.set(key, series);
        }
        return series;
    }

    /** Declares a family so it is exported (with HELP/TYPE) before the first sample. */
    describe(name, type, help) {
        this.#family(name, type, help);
    }

    inc(name, help, labels = {}, by = 1) {
        this.#series(name, 'counter', help, labels).value += by;
    }

    add(name, help, labels = {}, by = 1) {
        this.#series(name, 'gauge', help, labels).value += by;
    }

    set(name, help, labels = {}, value = 0) {
        this.#series(name, 'gauge', help, labels).value = value;
    }

    render() {
        for (const collector of this.#collectors) collector();
        const lines = [];
        for (const [name, { type, help, series }] of this.#families) {
            lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
            for (const { labels, value } of series.values()) lines.push(`${name}${formatLabels(labels)} ${value}`);
        }
        return `${lines.join('\n')}\n`;
    }
}

function escapeLabel(value) {
    return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function formatLabels(labels) {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

/** Serves GET /metrics. Resolves once listening; rejects on bind errors. */
export function startMetricsServer(metrics, { host = '0.0.0.0', port }) {
    const server = http.createServer((request, response) => {
        if (request.method === 'GET' && request.url.split('?')[0] === '/metrics') {
            const body = metrics.render();
            response.writeHead(200, {
                'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
            });
            response.end(body);
            return;
        }
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('404 Not Found\n');
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.removeListener('error', reject);
            resolve(server);
        });
    });
}
