import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createNaverMailServer } from "../src/server.js";

const json = async (path: string) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));

test("both hosts load the same plugin with separate MCP configuration", async () => {
  const codex = await json(".codex-plugin/plugin.json");
  const claude = await json(".claude-plugin/plugin.json");
  const pkg = await json("package.json");
  assert.equal(codex.name, claude.name);
  assert.equal(codex.version, pkg.version);
  assert.equal(claude.version, pkg.version);
  assert.equal(codex.mcpServers, "./.codex-plugin/mcp.json");
  const market = await json(".claude-plugin/marketplace.json");
  assert.equal(market.plugins[0].name, claude.name);
  assert.equal(market.plugins[0].source, "./");
  const config = (await json(".mcp.json")).mcpServers.naver_mail;
  assert.deepEqual(Object.keys(config).sort(), ["args", "command", "type"]);
  assert.equal(config.type, "stdio");
  assert.equal(config.command, "${CLAUDE_PLUGIN_ROOT}/bin/naver-mail-bridge");
});

test("Claude explicit consent metadata matches the Codex tool approval policy over MCP", async () => {
  const config = (await json(".codex-plugin/mcp.json")).mcpServers.naver_mail;
  const bundle = createNaverMailServer();
  const client = new Client({ name: "host-policy-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await bundle.server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 12);
    for (const tool of tools) {
      assert.equal(tool._meta?.["anthropic/requiresUserInteraction"] === true,
        config.tools[tool.name]?.approval_mode === "prompt", tool.name);
    }
    assert.equal(tools.find(t => t.name === "send_mail")?._meta?.["anthropic/requiresUserInteraction"], true);
  } finally {
    await client.close();
    await bundle.close();
  }
});
