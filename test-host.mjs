/**
 * Drives the Host half with a fake Cordis context, against the live endpoint.
 * Not part of the published package.
 *
 *   node test-host.mjs
 */
import * as plugin from './index.js';

const { apply } = plugin;

// Regression guard: without an `inject` declaration Cordis activates this plugin
// immediately, before the `tools` service exists, so `ctx.tools` is undefined and
// `apply()` throws at the tool registration — silently dropping the tool *and* the
// route registered after it. The fake context below always provides `tools`, so
// only this assertion catches that mistake.
if (!Array.isArray(plugin.inject) || !plugin.inject.includes('tools')) {
  console.error("FAIL: the plugin must export inject = ['tools'] (got: " + JSON.stringify(plugin.inject) + ')');
  process.exit(1);
}

const tools = [];
const routes = [];
const effects = [];
const intervals = [];

const ctx = {
  effect(fn, label) {
    const dispose = fn();
    effects.push({ label, dispose });
  },
  inject(names, fn) {
    if (!names.includes('webServer')) return;
    fn({ effect: (f, l) => ctx.effect(f, l), webServer: { register: (r) => (routes.push(r), () => {}) } });
  },
  tools: { register: (definition) => (tools.push(definition), () => {}) },
};

// Capture the polling timer instead of leaving it running.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => {
  intervals.push({ fn, ms });
  return intervals.length;
};

apply(ctx, {});

console.log('--- registered tool:', tools.map((t) => t.name).join(', ') || '(none)');
console.log('--- registered routes:', routes.map((r) => `${r.kind} ${r.path}`).join(', ') || '(none)');
console.log('--- poll interval:', intervals.map((i) => `${i.ms}ms`).join(', ') || '(none)');
console.log('--- effects:', effects.map((e) => e.label).join(', ') || '(none)');

const tool = tools[0];
if (tool === undefined) {
  console.error('FAIL: no tool registered');
  process.exit(1);
}

console.log('\n=== tool output (force refresh) ===');
const text = await tool.execute({ refresh: true });
console.log(text);

console.log('\n=== route response ===');
const route = routes[0];
const sent = { status: null, headers: null, body: null };
await route.handler(
  { method: 'GET', url: '/openrouter-balance/balance.json' },
  {
    writeHead(status, headers) {
      sent.status = status;
      sent.headers = headers;
    },
    end(body) {
      sent.body = body;
    },
  },
);
console.log('HTTP', sent.status, sent.headers?.['content-type']);
console.log(sent.body);

console.log('\n=== method guard (POST) ===');
const guard = { status: null, body: null };
await route.handler(
  { method: 'POST', url: '/openrouter-balance/balance.json' },
  { writeHead: (s) => (guard.status = s), end: (b) => (guard.body = b) },
);
console.log('HTTP', guard.status, guard.body);

console.log('\n=== failure path: bad key ===');
const badTools = [];
const badCtx = {
  effect(fn) {
    fn();
  },
  inject(names, fn) {
    if (names.includes('webServer')) fn({ effect: (f) => f(), webServer: { register: () => () => {} } });
  },
  tools: { register: (d) => (badTools.push(d), () => {}) },
};
apply(badCtx, { apiKey: 'not-a-real-token' });
const bad = await badTools[0].execute({ refresh: true });
console.log(bad);

// Restore and clear the captured timers so the process can exit.
globalThis.setInterval = realSetInterval;
process.exit(0);
