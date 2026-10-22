import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findImports, localPathFor, makeWorldReadable } from '../scripts/vendor-schemas.js';
import { resolveImport } from '../src/onvif-server.js';

test('findImports resolves relative locations against the document URL', () => {
    const wsdl = '<wsdl:import namespace="x" location="../../../ver10/schema/onvif.xsd"/>';
    assert.deepEqual(findImports(wsdl, 'https://www.onvif.org/ver10/media/wsdl/media.wsdl'), [
        'https://www.onvif.org/ver10/schema/onvif.xsd',
    ]);
});

test('findImports handles attributes spread over several lines', () => {
    const xsd = '<xsd:import\n    namespace="http://docs.oasis-open.org/wsrf/bf-2"\n    schemaLocation="http://docs.oasis-open.org/wsrf/bf-2.xsd"/>';
    assert.deepEqual(findImports(xsd, 'http://docs.oasis-open.org/wsn/b-2.xsd'), [
        'http://docs.oasis-open.org/wsrf/bf-2.xsd',
    ]);
});

test('findImports ignores endpoint addresses', () => {
    const wsdl = '<soap:address location="http://localhost:8000/onvif/media_service"/>';
    assert.deepEqual(findImports(wsdl, 'https://www.onvif.org/x.wsdl'), []);
});

test('localPathFor mirrors host and path', () => {
    assert.equal(
        localPathFor('https://www.w3.org/2005/08/addressing/ws-addr.xsd', '/v'),
        path.join('/v', 'www.w3.org', '2005', '08', 'addressing', 'ws-addr.xsd'),
    );
});

test('makeWorldReadable opens a 0700 tree for other users', { skip: process.platform === 'win32' && 'no POSIX modes' }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-'));   // mkdtemp creates 0700
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const nested = path.join(dir, 'www.onvif.org', 'ver10');
    fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(nested, 'onvif.xsd'), '<xs:schema/>', { mode: 0o600 });

    await makeWorldReadable(dir);

    assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
    assert.equal(fs.statSync(nested).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(nested, 'onvif.xsd')).mode & 0o777, 0o644);
});

test('resolveImport prefers the vendored copy and falls back to the URL', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const local = path.join(dir, 'www.onvif.org', 'ver10', 'schema', 'onvif.xsd');
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, '<xs:schema/>');

    assert.equal(resolveImport('https://www.onvif.org/ver10/schema/onvif.xsd', dir), local);
    assert.equal(resolveImport('https://www.onvif.org/ver10/schema/common.xsd', dir), 'https://www.onvif.org/ver10/schema/common.xsd');
    assert.equal(resolveImport('/already/local.xsd', dir), '/already/local.xsd');
});
