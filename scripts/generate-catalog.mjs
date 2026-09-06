import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNaverMailServer } from '../dist/server.js';
import { PLUGIN_VERSION } from '../dist/constants.js';
const [a,b]=InMemoryTransport.createLinkedPair();
const bundle=createNaverMailServer();
const client=new Client({name:'naver-mail-catalog-builder',version:PLUGIN_VERSION});
try {
  await bundle.server.connect(b);
  await client.connect(a);
  const result=await client.listTools();
  if(result.tools.length!==12) throw new Error('Expected 12 public tools');
  await writeFile(new URL('../dist/tool-catalog.json',import.meta.url),JSON.stringify({version:PLUGIN_VERSION,result},null,2)+'\n');
} finally { await client.close(); await bundle.shutdown(); }
