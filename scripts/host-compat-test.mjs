// Exercise real stdio binaries from each host's manifest, without mail or keyring access.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(process.argv[2] ?? '.');
const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'));
const codexManifest = await json('.codex-plugin/plugin.json');
const claudeManifest = await json('.claude-plugin/plugin.json');
const codex = (await json(codexManifest.mcpServers)).mcpServers.naver_mail;
const claude = (await json('.mcp.json')).mcpServers.naver_mail;
assert.equal(codexManifest.version, claudeManifest.version);
const expected = (await json('dist/tool-catalog.json')).result.tools;
const unrelatedCwd = await mkdtemp(join(tmpdir(), 'naver-host-cwd-'));
try {
  for (const [host, config, command, cwd] of [
    ['codex', codex, resolve(root, codex.command), root],
    ['claude', claude, claude.command.replace('${CLAUDE_PLUGIN_ROOT}', root), unrelatedCwd]
  ]) {
    const transport = new StdioClientTransport({command, args: config.args, cwd, stderr: 'pipe'});
    const client = new Client({name: `naver-${host}-compat-test`, version: '1.0.0'});
    try {
      await client.connect(transport);
      const {tools} = await client.listTools();
      assert.equal(tools.length, 12);
      for (const tool of tools) {
        const original = expected.find(t => t.name === tool.name);
        assert.ok(original, tool.name);
        assert.deepEqual(tool.inputSchema, original.inputSchema, tool.name);
        assert.deepEqual(tool._meta, original._meta, tool.name);
      }
      assert.equal(tools.find(t => t.name === 'send_mail')._meta['anthropic/requiresUserInteraction'], true);
      console.log(JSON.stringify({host, platform: process.platform, tools: tools.length, approvalMetadata: true, unrelatedCwd: host === 'claude'}));
    } finally { await client.close(); }
  }
} finally { await rmdir(unrelatedCwd); }
