// Isolated Claude CLI registration test; never opens a model session or accesses mail.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const plugin = resolve(process.argv[2] ?? `.build-package/${process.platform}-${process.arch}/naver-mail`);
const prefix = resolve(process.env.NAVER_MAIL_CLAUDE_TEST_PREFIX ?? '.build-claude');
const cliRoot = join(prefix, 'node_modules/@anthropic-ai/claude-code');
const pkg = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8'));
const cli = join(cliRoot, pkg.bin.claude);
const profile = await mkdtemp(join(tmpdir(), 'naver-claude-test-'));
const env = {...process.env, CLAUDE_CONFIG_DIR: profile, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1'};
function run(args) {
  const result = spawnSync(cli, args, {env, encoding: 'utf8', timeout: 120_000, windowsHide: true});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  run(['plugin', 'validate', plugin, '--strict']);
  run(['plugin', 'validate', join(plugin, '.claude-plugin/plugin.json'), '--strict']);
  run(['plugin', 'marketplace', 'add', plugin]);
  run(['plugin', 'install', 'naver-mail@eziwork-naver-mail', '--scope', 'user']);
  const listing = run(['plugin', 'list', '--json']);
  assert.ok(listing.includes('naver-mail@eziwork-naver-mail'), listing);
  const details = run(['plugin', 'details', 'naver-mail']);
  assert.match(details, /naver_mail/);
  run(['plugin', 'uninstall', 'naver-mail@eziwork-naver-mail', '--scope', 'user']);
  run(['plugin', 'marketplace', 'remove', 'eziwork-naver-mail']);
  console.log(JSON.stringify({claudeVersion: pkg.version, install: true, skillAndMcpInventory: details, uninstall: true}));
} finally {
  if (!resolve(profile).startsWith(resolve(tmpdir()) + sep) || !profile.split(sep).at(-1).startsWith('naver-claude-test-')) throw Error('Unsafe cleanup');
  await rm(profile, {recursive: true, force: true});
}
