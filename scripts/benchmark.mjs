// Synthetic local calls only: never reads credentials or sends mail.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testRoot = await mkdtemp(join(tmpdir(), 'naver-mail-benchmark-'));
const idleMs = process.argv.includes('--real-idle') ? 30_000 : 1_000;
const env = {...process.env, NAVER_MAIL_TEST_ROOT: testRoot, NAVER_MAIL_TEST_IDLE_MS: String(idleMs)};
if (process.argv.includes('--bundled')) delete env.CODEX_MCP_NODE_PATH;
else env.CODEX_MCP_NODE_PATH = process.execPath;
const transport = new StdioClientTransport({command: join(root, 'bin', 'naver-mail-bridge'), args: [], cwd: root, stderr: 'pipe', env});
const client = new Client({name: 'benchmark', version: '0.2.1'});
const alive = pid => {try {process.kill(pid, 0); return true;} catch {return false;}};
const workers = new Set();
function memory(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0);
  if (process.platform === 'win32') {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} | Select-Object WorkingSet64,PrivateMemorySize64) | ConvertTo-Json -Compress`], {encoding: 'utf8', windowsHide: true}));
  }
  return {WorkingSet64: Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], {encoding: 'utf8'}).trim()) * 1024};
}
try {
  const initializedAt = performance.now();
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 12);
  const initializeMs = Math.round(performance.now() - initializedAt);
  const samples = [{phase: 'discovery', ...memory(transport.pid)}];
  const coldMs = [];
  for (let cycle = 0; cycle < 5; cycle++) {
    const start = performance.now();
    const result = await client.callTool({name: 'send_plan_status', arguments: {planId: 'nonexistent-benchmark-plan'}});
    coldMs.push(Math.round(performance.now() - start));
    assert.ok(!result.isError);
    const worker = JSON.parse(await readFile(join(testRoot, 'worker.json'), 'utf8'));
    workers.add(worker.pid);
    await delay(idleMs + 1500);
    assert.equal(alive(worker.pid), false);
    samples.push({phase: `idle-cycle-${cycle + 1}`, ...memory(transport.pid)});
  }
  const report = {passed: true, platform: process.platform, arch: process.arch, version: '0.2.1', date: new Date().toISOString(), idleMs, runtime: process.argv.includes('--bundled') ? 'bundled' : 'host', connections: 1, initializeMs, coldMs, samples, maximumIdleMiB: Math.max(...samples.map(s => s.WorkingSet64)) / 1024 ** 2, idleNodeCount: 0};
  report.passed=report.maximumIdleMiB<=20 && Math.max(...coldMs)<=3000;
  const output = process.env.NAVER_MAIL_BENCHMARK_OUTPUT;
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  assert.ok(report.maximumIdleMiB <= 20, `Idle memory exceeded 20 MiB: ${report.maximumIdleMiB}`);
  assert.ok(Math.max(...coldMs) <= 3000, `Local worker startup exceeded 3 seconds: ${coldMs}`);
  console.log(JSON.stringify(report));
} finally {
  await client.close();
  for (const pid of workers) if (alive(pid)) {try {process.kill(pid);} catch {}}
  await delay(250);
  if (!resolve(testRoot).startsWith(resolve(tmpdir()) + sep + 'naver-mail-benchmark-')) throw new Error('Unsafe test cleanup');
  await rm(testRoot, {recursive: true, force: true});
}
