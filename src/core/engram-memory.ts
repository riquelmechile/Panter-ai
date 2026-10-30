/** Curated, project-bound Engram MCP memory. Only GPT-A can access durable knowledge.
 * Worker assertions remain A2A evidence, not automatically trusted memories.
 */
export type MemoryPrincipal = 'gpt-a' | 'gpt-b' | 'grok' | 'gemini' | 'claude';
export type MemoryType = 'decision' | 'architecture' | 'bugfix' | 'pattern' | 'config' | 'discovery' | 'learning';
export type EngramToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
};
export type EngramClient = {
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<EngramToolResult>;
  close(): Promise<void>;
};
export type MemoryBridgeConfig = {
  project: string;
  openClient: () => Promise<EngramClient>;
};
const TOPIC = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const NAME = /^[a-z][a-z0-9-]{1,79}$/;
function requireLeader(principal: MemoryPrincipal) {
  if (principal !== 'gpt-a') throw new Error('Only GPT-A can access curated project memory');
}
function requireValid(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}
function bounded(value: string, max: number, label: string): string {
  requireValid(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `Invalid ${label}`);
  return value.trim();
}
/** Operator-owned MCP bridge: no autonomous summaries, model inference, or cross-project query. */
export class EngramMemory {
  private connection: Promise<EngramClient> | undefined;
  readonly project: string;
  constructor(private readonly config: MemoryBridgeConfig) {
    requireValid(NAME.test(config.project), 'Invalid fixed Engram project');
    this.project = config.project;
  }
  private client(): Promise<EngramClient> {
    if (!this.connection) {
      this.connection = this.config.openClient().catch(error => {
        this.connection = undefined;
        throw error;
      });
    }
    return this.connection;
  }
  async close(): Promise<void> {
    const previous = this.connection;
    this.connection = undefined;
    if (previous) await (await previous).close();
  }
  private async call(principal: MemoryPrincipal, name: string, args: Record<string, unknown>) {
    requireLeader(principal);
    const client = await this.client();
    let result: EngramToolResult;
    try { result = await client.callTool({ name, arguments: args }); }
    catch (e) { this.connection = undefined; await client.close().catch(() => {}); throw e; }
    if (result.isError) {
      // Engram errors are data (never reinterpret an error as a successful save).
      const error = result.content?.find(item => item.type === 'text')?.text;
      throw new Error(`Engram ${name} failed: ${(error ?? 'unknown error').slice(0, 600)}`);
    }
    return { project: this.project, tool: name, result };
  }
  /** Scoped search. Never enable all_projects, personal or global scope over this bridge. */
  search(principal: MemoryPrincipal, query: string, limit = 8) {
    requireValid(Number.isInteger(limit) && limit >= 1 && limit <= 20, 'Invalid search limit');
    return this.call(principal, 'mem_search', { query: bounded(query, 500, 'memory query'), project: this.project, scope: 'project', limit });
  }
  /** Compact recovery context for the orchestrator, not a blanket prompt injection. */
  context(principal: MemoryPrincipal, maxBytes = 8192) {
    requireValid(Number.isInteger(maxBytes) && maxBytes >= 512 && maxBytes <= 16384, 'Invalid memory budget');
    return this.call(principal, 'mem_context', { project: this.project, scope: 'project', compact: true, max_bytes: maxBytes });
  }
  /** Curated saves only; worker claims and unverified evidence cannot self-promote. */
  save(principal: MemoryPrincipal, input: { title: string; type: MemoryType; topicKey: string; content: string }) {
    requireValid(TOPIC.test(input.topicKey) && !input.topicKey.includes('//') && !input.topicKey.includes('../'), 'Invalid topic key');
    const title = bounded(input.title, 160, 'memory title');
    const content = bounded(input.content, 16000, 'memory content');
    // Fail closed on common direct credential material; Engram has its own redaction too.
    requireValid(!/(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-proj-|ghp_|github_pat_)[A-Za-z0-9_-]{12,})/i.test(content), 'Credential material is not allowed in memory');
    const types = new Set<MemoryType>(['decision', 'architecture', 'bugfix', 'pattern', 'config', 'discovery', 'learning']);
    requireValid(types.has(input.type), 'Invalid memory type');
    return this.call(principal, 'mem_save', { project: this.project, scope: 'project', title, type: input.type, topic_key: input.topicKey, content, capture_prompt: false });
  }
  /** The app has no authoritative prompt provenance; store only an explicit session summary. */
  summary(principal: MemoryPrincipal, content: string) {
    return this.call(principal, 'mem_session_summary', { project: this.project, content: bounded(content, 12000, 'session summary') });
  }
}
