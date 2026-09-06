import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const transport = new StdioClientTransport({command: join(root, "bin", "naver-mail-bridge"), args: [], cwd: root, stderr: "pipe"});
const client = new Client({ name: "naver-mail-smoke", version: "0.2.0" }, { capabilities: {} });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  const expected = [
    "connection_status",
    "open_setup",
    "disconnect_account",
    "list_mailboxes",
    "search_mail",
    "get_mail",
    "get_mail_batch",
    "save_attachment",
    "set_read_status",
    "prepare_send",
    "send_plan_status",
    "send_mail"
  ];
  for (const name of expected) assert.ok(names.has(name), `missing MCP tool: ${name}`);
  assert.equal(listed.tools.length, expected.length);
  process.stdout.write(`MCP smoke test passed (${listed.tools.length} tools).\n`);
} finally {
  await client.close();
}
