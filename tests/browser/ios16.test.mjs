import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium, webkit } from '@playwright/test';

for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`${engine}: file and Function clients work with Safari 16 abort capabilities`, async () => {
    const server = createServer(async (req, res) => {
      if (req.url === '/') { res.end('<!doctype html><meta charset="utf-8"><title>SDK</title>'); return; }
      res.setHeader('content-type', 'text/javascript');
      res.end(await readFile(new URL('../..' + req.url, import.meta.url)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
      browser = await type.launch();
      const page = await browser.newPage();
      await page.addInitScript(() => Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined }));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const result = await page.evaluate(async () => {
        const { createTianaFiles, createTianaFunctions } = await import('/dist/index.js');
        const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
        let grants = 0, installs = 0, connections = 0;
        const files = createTianaFiles({
          apiBaseUrl: 'https://console.example.test/files',
          request: async () => {
            grants++;
            return json({ origin: 'https://files.example.test/', root: 'app/', scope_id: 'fixture', token: 'fixture', session_url: 'https://files.example.test/session', expires_at: Math.floor(Date.now() / 1000) + 900 });
          },
          fetch: async (url) => {
            if (url.endsWith('/session')) { installs++; return new Response(null, { status: 204 }); }
            return new Response('file content');
          },
        });
        await files.ready();
        const body = await (await files.get('test.txt', { signal: new AbortController().signal })).text();
        const cancelled = new AbortController(); cancelled.abort();
        let fileAbort;
        try { await files.getUrl('test.txt', { signal: cancelled.signal }); } catch (error) { fileAbort = error.name; }
        const functions = createTianaFunctions({
          connection: async id => { connections++; return { instance_id: id, origin: 'https://fn.example.test', token: 'fixture', expires_at: Math.floor(Date.now() / 1000) + 60 }; },
          fetch: async (_url, init) => new Response(new Headers(init.headers).get('authorization')),
        });
        const reply = await (await functions.fetch('fn', '/hello', { signal: new AbortController().signal })).text();
        let functionAbort;
        try { await functions.fetch('fn', '/hello', { signal: cancelled.signal }); } catch (error) { functionAbort = error.name; }
        functions.dispose(); files.dispose();
        return { grants, installs, body, fileAbort, connections, reply, functionAbort };
      });
      assert.deepEqual(result, { grants: 1, installs: 1, body: 'file content', fileAbort: 'AbortError', connections: 1, reply: 'Bearer fixture', functionAbort: 'AbortError' });
    } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
  });
}
