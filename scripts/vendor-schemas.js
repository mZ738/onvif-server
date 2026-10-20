#!/usr/bin/env node
/**
 * Downloads the schema chain imported by wsdl/*.wsdl into wsdl/vendor/, so the
 * server can start without internet access.
 *
 * The WSDLs import the official Onvif schemas, which in turn import OASIS and
 * W3C schemas (about a dozen files on three hosts). node-soap fetches them on
 * every start; if one of them is unreachable, the affected service answers
 * every request with HTTP 500 (see startServer()).
 *
 * Files are stored unmodified under wsdl/vendor/<host>/<path>. Unmodified on
 * purpose: the Onvif license header permits copying but not modifying the
 * documents. The redirect to the local copies happens in the server through
 * node-soap's overrideImportLocation option instead.
 *
 * Usage: node scripts/vendor-schemas.js [target-dir]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..');
const TARGET = path.resolve(process.argv[2] ?? path.join(ROOT, 'wsdl', 'vendor'));
const ENTRY_POINTS = [
    'https://www.onvif.org/ver10/device/wsdl/devicemgmt.wsdl',
    'https://www.onvif.org/ver10/media/wsdl/media.wsdl',
];

// Attributes of one import may span several lines (b-2.xsd does), so the
// document is flattened before matching.
const IMPORT_RE = /<(?:[\w-]+:)?(?:import|include)\b[^>]*?\b(?:schemaLocation|location)\s*=\s*"([^"]+)"/g;

export function findImports(text, baseUrl) {
    const flat = text.replace(/\s+/g, ' ');
    return [...flat.matchAll(IMPORT_RE)].map(([, location]) => new URL(location, baseUrl).href);
}

export function localPathFor(url, root) {
    const { host, pathname } = new URL(url);
    return path.join(root, host, ...pathname.split('/').filter(Boolean));
}

async function fetchText(url, attempts = 3) {
    for (let attempt = 1; ; attempt++) {
        try {
            const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.text();
        } catch (error) {
            if (attempt >= attempts) throw new Error(`${url}: ${error.message}`);
            await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
    }
}

async function main() {
    await fs.mkdir(path.dirname(TARGET), { recursive: true });
    const staging = await fs.mkdtemp(`${TARGET}.tmp-`);
    try {
        const seen = new Set();
        const queue = [...ENTRY_POINTS];
        const sums = [];

        while (queue.length > 0) {
            const url = queue.shift();
            if (seen.has(url)) continue;
            seen.add(url);

            const text = await fetchText(url);
            const file = localPathFor(url, staging);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, text);

            sums.push(`${createHash('sha256').update(text).digest('hex')}  ${path.relative(staging, file).split(path.sep).join('/')}`);
            queue.push(...findImports(text, url));
        }

        sums.sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
        await fs.writeFile(path.join(staging, 'SHA256SUMS'), `${sums.join('\n')}\n`);

        // Swap atomically, so a failed download never leaves a half-filled directory.
        const previous = `${TARGET}.old`;
        await fs.rm(previous, { recursive: true, force: true });
        await fs.rename(TARGET, previous).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        await fs.rename(staging, TARGET);
        await fs.rm(previous, { recursive: true, force: true });

        process.stdout.write(`${sums.length} schema files stored in ${TARGET}\n`);
    } catch (error) {
        await fs.rm(staging, { recursive: true, force: true });
        throw error;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`vendor-schemas: ${error.message}\n`);
        process.exitCode = 1;
    });
}
