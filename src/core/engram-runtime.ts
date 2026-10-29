/** Spawn the upstream Engram binary exclusively over stdio MCP.
 * No shell, untrusted executable paths, shared global Engram store or cloud sync.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { EngramMemory, type EngramClient } from './engram-memory.js';

export async function openEngramBridge(dataDir: string, executable = 'engram') {
  if (!/^(?:engram|\/[\w./-]+)$/.test(executable) || executable.includes('..')) throw new Error('Unsafe Engram executable');
  const dir = resolve(dataDir, 'engram');
  const workspace = join(dir, 'workspace');
  await mkdir(join(workspace, '.engram'), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, 'data'), { recursive: true, mode: 0o700 });
  // The project setting is operator-owned; no app client can override it.
  await writeFile(join(workspace, '.engram', 'config.json'), '{"project_name":"panter-ai"}\n', { mode: 0o600 });
  return new EngramMemory({ project: 'panter-ai', openClient: async (): Promise<EngramClient> => {
    const client = new Client({ name: 'panter-engram-bridge', version: '0.8.0' });
    const transport = new StdioClientTransport({
      command: executable, args: ['mcp', '--tools=agent', '--project', 'panter-ai'], cwd: workspace,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME ?? '/nonexistent',
        ENGRAM_PROJECT: 'panter-ai', ENGRAM_DATA_DIR: join(dir, 'data'),
        ENGRAM_CLOUD_AUTOSYNC: '0', ENGRAM_NO_UPDATE_CHECK: '1',
      },
    });
    try { await client.connect(transport); }
    catch (err) { await client.close().catch(() => {}); throw err; }
    return client;
  } });
}
