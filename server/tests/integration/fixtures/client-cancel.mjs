// Run in a child process so builtin stubs cannot leak into other Bun suites.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import os from 'node:os';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const temp = mkdtempSync(join(os.tmpdir(), 'octoally-client-cancel-'));
const workspace = join(temp, 'workspace');
mkdirSync(workspace);
// config.ts migrates legacy paths under homedir; isolate those as well as SQLite.
os.homedir = () => temp;
process.env.DB_PATH = join(temp, 'test.db');
process.env.OCTOALLY_USE_DTACH = 'false';
process.env.OCTOALLY_USE_TMUX = 'false';
const workers = [];
class StubWorker extends EventEmitter {
  connected = true;
  killed = false;
  send(message) {
    if (message.type === 'spawn') {
      setImmediate(() => this.emit('message', { type: 'ready', pid: null }));
    } else if (message.type === 'kill') {
      this.killed = true;
      this.connected = false;
      this.emit('message', { type: 'killed' });
    } else {
      throw new Error(`Unexpected worker message: ${message.type}`);
    }
    return true;
  }
  kill() { throw new Error('No real process exists to kill'); }
}
cp.fork = (file) => {
  assert.match(file, /pty-worker\.(ts|js)$/);
  const worker = new StubWorker();
  workers.push(worker);
  setImmediate(() => worker.emit('message', { type: 'worker-ready' }));
  return worker;
};
cp.execFile = (file, args, options, callback) => {
  assert.equal(file, 'openclaw');
  assert.deepEqual(args.slice(0, 2), ['system', 'event']);
  const cb = typeof options === 'function' ? options : callback;
  if (cb) setImmediate(() => cb(null, '', ''));
  return new EventEmitter();
};
for (const name of ['spawn', 'exec', 'execSync', 'execFileSync', 'spawnSync']) {
  cp[name] = () => { throw new Error(`Forbidden subprocess: ${name}`); };
}
syncBuiltinESMExports();

const require = createRequire(join(root, 'server/package.json'));
const Fastify = require('fastify');
const { initDb, getDb } = await import(root + 'server/src/db/index.ts');
initDb();
const db = getDb();
const manager = await import(root + 'server/src/services/session-manager.ts');
const { sessionRoutes } = await import(root + 'server/src/routes/sessions.ts');
const { agentRoutes } = await import(root + 'server/src/routes/agent.ts');
const { checkLock } = await import(root + 'server/src/services/workspace-lock.ts');
const { OctoAllyClient, OctoAllyRequestError, cancel } = await import(root + 'integration-client/octoally_research_session.ts');
const app = Fastify();
await app.register(sessionRoutes, { prefix: '/api' });
await app.register(agentRoutes, { prefix: '/api' });
await app.ready();
const calls = [];
const client = new OctoAllyClient({
  baseUrl: 'http://isolated.test',
  fetchImpl: async (input, init = {}) => {
    const url = new URL(input);
    calls.push([init.method ?? 'GET', url.pathname]);
    const result = await app.inject({ method: init.method ?? 'GET', url: url.pathname, payload: init.body, headers: Object.fromEntries(new Headers(init.headers)) });
    return new Response(result.body, { status: result.statusCode, headers: { 'content-type': 'application/json' } });
  },
});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function launch() {
  const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: { project_path: workspace, task: 'Harmless worker fixture' } });
  assert.equal(response.statusCode, 200);
  const id = response.json().session.id;
  const pending = manager.consumePendingSpawn(id);
  assert.ok(pending);
  await manager.spawnSession(id, workspace, pending.task, 120, 40, pending.cliType);
  await tick();
  assert.equal(manager.getSession(id).status, 'running');
  return id;
}
try {
  const id = await launch();
  assert.equal(checkLock(workspace, db).session.id, id);
  const worker = workers[0];
  // Execute-only cancellation must retain its existing session/lock semantics.
  const executeCancel = await app.inject({ method: 'POST', url: `/api/sessions/${id}/cancel` });
  assert.equal(executeCancel.statusCode, 200);
  assert.equal(manager.getSession(id).status, 'running');
  assert.equal(checkLock(workspace, db).locked, true);
  const result = await cancel(id, { client });
  assert.deepEqual(result, { sessionId: id, status: 'cancelled', cancelled: true, lockReleased: true });
  assert.deepEqual(calls.slice(0, 2), [['DELETE', `/api/sessions/${id}`], ['GET', `/api/sessions/${id}`]]);
  assert.equal(worker.killed, true);
  assert.equal(manager.isSessionActive(id), false);
  const cancelled = manager.getSession(id);
  assert.equal(cancelled.lock_key, workspace); // Historical key is intentionally retained.
  assert.ok(cancelled.completed_at);
  assert.equal(checkLock(workspace, db).locked, false);
  await assert.rejects(() => cancel(id, { client }), e => e instanceof OctoAllyRequestError && e.statusCode === 404);
  assert.deepEqual(manager.getSession(id), cancelled);
  const next = await launch();
  assert.notEqual(next, id);
  assert.equal(checkLock(workspace, db).session.id, next);
  worker.emit('message', { type: 'exit', exitCode: 0, signal: null });
  await tick();
  assert.deepEqual(manager.getSession(id), cancelled);
  assert.equal(checkLock(workspace, db).session.id, next);
  workers[1].emit('message', { type: 'exit', exitCode: 0, signal: null });
  await tick();
  const completed = manager.getSession(next);
  assert.equal(completed.status, 'completed');
  await assert.rejects(() => cancel(next, { client }), e => e instanceof OctoAllyRequestError && e.statusCode === 404);
  assert.deepEqual(manager.getSession(next), completed);
  await assert.rejects(() => cancel('missing', { client }), e => e instanceof OctoAllyRequestError && e.statusCode === 404);
  assert.equal(checkLock(workspace, db).locked, false);
  assert.equal(workers.length, 2);
  console.log('PASS real-route shared cancellation, retained key, replacement writer and terminal races');
} finally {
  await app.close();
  db.close();
  rmSync(temp, { recursive: true, force: true });
}
// Session-manager kill timers are irrelevant after the isolated assertions/cleanup.
process.exit(0);
