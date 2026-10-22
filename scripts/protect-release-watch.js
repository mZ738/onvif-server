#!/usr/bin/env node
/**
 * Watches Ubiquiti's UniFi Protect release notes for entries about third-party
 * (Onvif) cameras. Ubiquiti's help centre blocks scripted requests, the release
 * feed does not, so the feed is what gets watched.
 *
 * Reads the feed, keeps the lines that mention third-party cameras or Onvif,
 * compares them with the stored snapshot and writes the snapshot back. New or
 * changed entries go to the report file as Markdown; the exit code stays 0.
 *
 *   node scripts/protect-release-watch.js [--snapshot docs/watch/protect-releases.json] [--report report.md]
 *
 * Prints `changed=true|false` as the last line (and to $GITHUB_OUTPUT when set).
 */
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

const FEED_URL = 'https://community.ui.com/rss/releases/UniFi-Protect/aada5f38-35d4-4525-9235-b14bd320e4d0';
const PATTERN = /third[- ]?party|onvif/i;

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const snapshotPath = option('--snapshot', 'docs/watch/protect-releases.json');
const reportPath = option('--report', null);

const cdata = (text) => text.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
const field = (item, name) => {
    const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
    return m ? cdata(m[1]) : '';
};
const decode = (text) => text
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
/** HTML description -> plain text lines (one per paragraph, heading or list item). */
const lines = (html) => html
    .split(/<\/?(?:p|li|h[1-6]|br|div|ul|ol)\b[^>]*>/i)
    .map((part) => decode(part.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);

const response = await fetch(FEED_URL, { headers: { 'User-Agent': 'onvif-server-protect-watch (+https://github.com/mZ738/onvif-server)' } });
if (!response.ok) throw new Error(`feed: HTTP ${response.status}`);
const xml = await response.text();

const items = [];
for (const [, body] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const matches = lines(field(body, 'description')).filter((line) => PATTERN.test(line));
    if (matches.length === 0) continue;
    items.push({
        title: field(body, 'title'),
        link: field(body, 'link'),
        published: field(body, 'pubDate'),
        matches,
    });
}

let previous = { items: [] };
try {
    previous = JSON.parse(await readFile(snapshotPath, 'utf8'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
const known = new Map(previous.items.map((item) => [item.link, item]));
const changed = items.filter((item) => {
    const old = known.get(item.link);
    return !old || JSON.stringify(old.matches) !== JSON.stringify(item.matches);
});

// Keep entries that dropped out of the feed (it only carries the last 20 releases).
const merged = [...items];
for (const item of previous.items) if (!items.some((i) => i.link === item.link)) merged.push(item);
await mkdir(path.dirname(snapshotPath), { recursive: true });
await writeFile(snapshotPath, `${JSON.stringify({ feed: FEED_URL, pattern: PATTERN.source, checked: new Date().toISOString(), items: merged }, null, 2)}\n`);

if (reportPath) {
    const report = [
        'The UniFi Protect release notes have new or changed entries about third-party cameras. Check whether they affect this server (adoption, events, audio, encoder settings) and update `docs/unifi-protect.md` if they do.',
        '',
        ...changed.flatMap((item) => [`## ${item.title} (${item.published})`, '', item.link, '', ...item.matches.map((line) => `- ${line}`), '']),
        'Ubiquiti\'s help article "Third-Party Camera Support" (https://help.ui.com/hc/en-us/articles/26301104828439) cannot be fetched by a script; look at it by hand when a release changes third-party behaviour.',
        '',
        `Snapshot: \`${snapshotPath}\`, feed: ${FEED_URL}`,
    ].join('\n');
    await writeFile(reportPath, `${report}\n`);
}

for (const item of changed) console.log(`${item.title}: ${item.matches.length} line(s)`);
const summary = `changed=${changed.length > 0}`;
if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `${summary}\nversions=${changed.map((i) => i.title.replace(/^UniFi Protect Application\s*/i, '')).join(', ')}\n`);
}
console.log(summary);
