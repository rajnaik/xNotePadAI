import type { APIRoute } from 'astro';
import { requireToken } from '../../lib/auth';
import { checkRateLimit, rateLimitResponse } from '../../lib/rate-limit';
import { checkAndTrackUsage } from '../../lib/billing';

export const prerender = false;

let envModule: any = null;
async function getEnv() {
  if (!envModule) {
    try { envModule = await import('cloudflare:workers'); } catch { /* don't cache failure — retry next call */ }
  }
  return envModule?.env || {};
}

// Streamable HTTP: GET returns 405 (we don't support SSE streaming)
export const GET: APIRoute = async () => {
  return new Response(null, { status: 405, headers: { 'Allow': 'POST' } });
};

// Streamable HTTP: DELETE terminates session (we don't track sessions, so 405)
export const DELETE: APIRoute = async () => {
  return new Response(null, { status: 405 });
};

// MCP (Model Context Protocol) server for xNotepad
// Implements the MCP JSON-RPC protocol over HTTP

interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

const TOOLS = [
  {
    name: 'create_note',
    description: 'Create a new note with optional title and content',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title' },
        content: { type: 'string', description: 'Note content' },
      },
      required: [],
    },
  },
  {
    name: 'list_notes',
    description: 'List all notes for a tenant with titles, word counts, and dates',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_note',
    description: 'Get the full content of a specific note by ID',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'Note ID' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'update_note',
    description: 'Update the content of an existing note',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'Note ID' },
        content: { type: 'string', description: 'New content' },
        title: { type: 'string', description: 'New title (optional)' },
      },
      required: ['note_id', 'content'],
    },
  },
  {
    name: 'delete_note',
    description: 'Delete a note by ID',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'Note ID to delete' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'search_notes',
    description: 'Semantic search across notes using AI (requires Vectorize)',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ask_notes',
    description: 'Ask a question about your notes — AI answers based on note content',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question to ask' },
      },
      required: ['question'],
    },
  },
  {
    name: 'get_versions',
    description: 'Get version history for a specific note',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'Note ID' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'tag_note',
    description: 'Add tags to a note',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'Note ID' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
      },
      required: ['note_id', 'tags'],
    },
  },
  {
    name: 'link_notes',
    description: 'Add a [[wiki-link]] from source note to target note title',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'string', description: 'Source note ID' },
        target_title: { type: 'string', description: 'Target note title to link to' },
      },
      required: ['source_id', 'target_title'],
    },
  },
  {
    name: 'merge_notes',
    description: 'Merge source note content into target note (source is deleted after merge)',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'string', description: 'Note to merge FROM (will be deleted)' },
        target_id: { type: 'string', description: 'Note to merge INTO' },
      },
      required: ['source_id', 'target_id'],
    },
  },
  {
    name: 'archive_note',
    description: 'Archive a note (mark as archived, hidden from main view)',
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'Note ID to archive' },
      },
      required: ['note_id'],
    },
  },
  {
    name: 'index_notes',
    description: 'Vectorise/index notes for semantic search. Call after creating multiple notes, or to re-index all notes.',
    inputSchema: {
      type: 'object',
      properties: {
        note_ids: { type: 'array', items: { type: 'string' }, description: 'Specific note IDs to index (optional — if empty, indexes all unindexed notes)' },
      },
      required: [],
    },
  },
];

export const POST: APIRoute = async ({ request }) => {
  try {
    // Rate limit: 30 requests per minute per IP (MCP runs expensive AI)
    const env = await getEnv();
    const db = env?.DB;
    const { allowed } = await checkRateLimit(db, request, 'mcp', 30);
    if (!allowed) return rateLimitResponse('mcp');

    // Auth check — validate token via centralised D1 lookup
    const body: MCPRequest = await request.json();
    const ai = env?.AI;
    const vectorize = env?.VECTORIZE;

    // Streamable HTTP: notifications have no "id" field — return 202 Accepted
    if (!body.id && body.method) {
      // This is a notification (e.g., notifications/initialized) — acknowledge with 202
      return new Response(null, { status: 202 });
    }

    const auth = await requireToken(request, db);
    if (!auth.valid) {
      return jsonRpcError(body.id || null, -32600, auth.error || 'Authentication required.');
    }

    // Tenant derived from token — args.tenant_id is IGNORED for security
    const authenticatedTenantId = auth.tenantId || '';

    // Billing / usage check — tracks every call, enforces limits when billing is ON
    const billing = await checkAndTrackUsage(db, authenticatedTenantId, 'mcp');
    if (!billing.allowed) {
      return jsonRpcError(body.id || null, -32000, billing.error || 'Usage limit exceeded.');
    }

    // Log MCP access (no note content logged — just method + tool)
    if (db) {
      const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '';
      const ua = request.headers.get('user-agent') || '';
      const toolName = body.params?.name || '';
      db.prepare(
        `INSERT INTO mcp_access_log (method, tool_name, tenant_id, ip_address, user_agent, success, details) VALUES (?, ?, ?, ?, ?, 1, '')`
      ).bind(body.method, toolName, authenticatedTenantId, ip, ua.slice(0, 200)).run().catch(() => {});
    }

    // Handle MCP protocol methods
    switch (body.method) {
      case 'initialize':
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'xnotepad-mcp', version: '3.0.0' },
          }
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': `xnotepad-${authenticatedTenantId}-${Date.now()}`,
          },
        });

      case 'tools/list':
        return jsonRpc(body.id, { tools: TOOLS });

      case 'tools/call':
        return handleToolCall(body, db, ai, vectorize, authenticatedTenantId);

      default:
        return jsonRpcError(body.id, -32601, `Method not found: ${body.method}`);
    }
  } catch (error: any) {
    return jsonRpcError(null, -32700, 'Parse error: ' + (error?.message || 'invalid JSON'));
  }
};

// === VECTORISATION HELPER ===
// Chunks note content and upserts embeddings into Vectorize
async function vectoriseNote(noteId: string, title: string, content: string, tenantId: string, ai: any, vectorize: any) {
  if (!ai || !vectorize || !content || content.length < 20) return;
  try {
    // Chunk: split into ~400-word segments
    const words = content.split(/\s+/);
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += 400) {
      chunks.push(words.slice(i, i + 400).join(' '));
    }
    if (chunks.length === 0) return;

    // Generate embeddings for all chunks
    const texts = chunks.map((c, i) => `${title}\n\n${c}`);
    const embedding = await ai.run('@cf/baai/bge-base-en-v1.5', { text: texts });
    if (!embedding?.data || embedding.data.length === 0) return;

    // Upsert to Vectorize
    const vectors = embedding.data.map((vec: number[], i: number) => ({
      id: `${noteId}-chunk-${i}`,
      values: vec,
      metadata: { noteId, noteTitle: title, tenantId, text: chunks[i].slice(0, 200), chunkIndex: i }
    }));
    await vectorize.upsert(vectors);
  } catch (e) {
    // Fail silently — vectorisation is best-effort
  }
}

async function handleToolCall(body: MCPRequest, db: any, ai: any, vectorize: any, tenantId: string) {
  const { name, arguments: args } = body.params || {};

  if (!db) {
    return jsonRpc(body.id, {
      content: [{ type: 'text', text: 'D1 database not available. Deploy to Cloudflare to use MCP tools.' }],
      isError: true,
    });
  }

  // tenantId comes from the authenticated token — NOT from args (args.tenant_id is ignored)

  switch (name) {
    case 'create_note': {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      // Agent writes are sandboxed with 'agent-created' tag (stored as JSON array)
      const initialTags = JSON.stringify(['agent-created']);
      await db.prepare(
        `INSERT INTO notes (id, tenant_id, title, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, tenantId, args.title || 'Untitled', args.content || '', initialTags, now, now).run();
      // Auto-vectorise for semantic search (non-blocking)
      vectoriseNote(id, args.title || 'Untitled', args.content || '', tenantId, ai, vectorize).catch(() => {});
      return jsonRpc(body.id, {
        content: [{ type: 'text', text: `Note created with ID: ${id}\nTitle: ${args.title || 'Untitled'}\nTag: agent-created (sandboxed)` }],
      });
    }

    case 'list_notes': {
      const results = await db.prepare(
        `SELECT id, title, LENGTH(content) as size_chars, updated_at FROM notes WHERE tenant_id = ? ORDER BY updated_at DESC`
      ).bind(tenantId).all();
      const notes = results.results || [];
      const text = notes.length === 0
        ? 'No notes found.'
        : notes.map((n: any) => `• ${n.title} (${n.size_chars} chars, updated ${n.updated_at})\n  ID: ${n.id}`).join('\n');
      return jsonRpc(body.id, { content: [{ type: 'text', text: `${notes.length} notes:\n\n${text}` }] });
    }

    case 'get_note': {
      const note = await db.prepare(
        `SELECT * FROM notes WHERE id = ? AND tenant_id = ?`
      ).bind(args.note_id, tenantId).first();
      if (!note) return jsonRpc(body.id, { content: [{ type: 'text', text: 'Note not found.' }], isError: true });
      return jsonRpc(body.id, {
        content: [{ type: 'text', text: `# ${note.title}\n\n${note.content}\n\n---\nUpdated: ${note.updated_at}` }],
      });
    }

    case 'update_note': {
      // Agent sandboxing: only allow updating agent-created notes
      const existing = await db.prepare('SELECT tags FROM notes WHERE id = ? AND tenant_id = ?').bind(args.note_id, tenantId).first();
      if (!existing) return jsonRpc(body.id, { content: [{ type: 'text', text: 'Note not found.' }], isError: true });
      if (!existing.tags || !existing.tags.includes('agent-created')) {
        return jsonRpc(body.id, { content: [{ type: 'text', text: 'Cannot update human-created notes via MCP. Agents can only modify notes tagged agent-created.' }], isError: true });
      }
      const now = new Date().toISOString();
      const title = args.title || args.content?.split('\n')[0]?.trim().slice(0, 50) || 'Untitled';
      await db.prepare(
        `UPDATE notes SET content = ?, title = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`
      ).bind(args.content, title, now, args.note_id, tenantId).run();
      // Re-vectorise on update
      vectoriseNote(args.note_id, title, args.content, tenantId, ai, vectorize).catch(() => {});
      return jsonRpc(body.id, { content: [{ type: 'text', text: `Note updated: ${title}` }] });
    }

    case 'delete_note': {
      // Agent sandboxing: only allow deleting agent-created notes
      const existing = await db.prepare('SELECT tags FROM notes WHERE id = ? AND tenant_id = ?').bind(args.note_id, tenantId).first();
      if (!existing) return jsonRpc(body.id, { content: [{ type: 'text', text: 'Note not found.' }], isError: true });
      if (!existing.tags || !existing.tags.includes('agent-created')) {
        return jsonRpc(body.id, { content: [{ type: 'text', text: 'Cannot delete human-created notes via MCP. Agents can only delete notes tagged agent-created.' }], isError: true });
      }
      await db.prepare(`DELETE FROM notes WHERE id = ? AND tenant_id = ?`).bind(args.note_id, tenantId).run();
      await db.prepare(`DELETE FROM note_versions WHERE note_id = ? AND tenant_id = ?`).bind(args.note_id, tenantId).run();
      return jsonRpc(body.id, { content: [{ type: 'text', text: 'Note deleted.' }] });
    }

    case 'search_notes': {
      if (!ai || !vectorize) {
        // Fallback: text search in D1
        const results = await db.prepare(
          `SELECT id, title, SUBSTR(content, 1, 200) as preview FROM notes WHERE tenant_id = ? AND content LIKE ? LIMIT 10`
        ).bind(tenantId, `%${args.query}%`).all();
        const notes = results.results || [];
        const text = notes.length === 0
          ? 'No matches found.'
          : notes.map((n: any) => `• ${n.title}\n  ${n.preview}...`).join('\n\n');
        return jsonRpc(body.id, { content: [{ type: 'text', text }] });
      }
      // Semantic search via Vectorize
      const embedding = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [args.query] });
      if (embedding?.data?.[0]) {
        const results = await vectorize.query(embedding.data[0], { topK: 5, filter: { tenantId } });
        const matches = results?.matches || [];
        const text = matches.length === 0
          ? 'No semantic matches found.'
          : matches.map((m: any) => `• ${m.metadata?.noteTitle || '?'} (score: ${m.score?.toFixed(3)})\n  ${m.metadata?.text?.slice(0, 150)}...`).join('\n\n');
        return jsonRpc(body.id, { content: [{ type: 'text', text }] });
      }
      return jsonRpc(body.id, { content: [{ type: 'text', text: 'Embedding generation failed.' }], isError: true });
    }

    case 'ask_notes': {
      if (!ai) {
        return jsonRpc(body.id, { content: [{ type: 'text', text: 'AI not available. Deploy with Workers AI binding.' }], isError: true });
      }
      // Get all notes as context (using authenticated tenantId)
      const results = await db.prepare(
        `SELECT title, content FROM notes WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 20`
      ).bind(tenantId).all();
      const notes = results.results || [];
      const context = notes.map((n: any) => `## ${n.title}\n${n.content}`).join('\n\n---\n\n');

      const response = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: `Answer based ONLY on the user's notes below. If the answer isn't in the notes, say so.\n\n${context.slice(0, 6000)}` },
          { role: 'user', content: args.question }
        ],
        max_tokens: 500,
        temperature: 0.3,
      });
      const answer = response?.response || 'No response from AI.';
      return jsonRpc(body.id, { content: [{ type: 'text', text: answer }] });
    }

    case 'get_versions': {
      const results = await db.prepare(
        `SELECT content, word_count, created_at FROM note_versions WHERE note_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 5`
      ).bind(args.note_id, tenantId).all();
      const versions = results.results || [];
      if (versions.length === 0) return jsonRpc(body.id, { content: [{ type: 'text', text: 'No versions found for this note.' }] });
      const text = versions.map((v: any, i: number) => `v${versions.length - i} (${v.created_at}, ${v.word_count} words):\n${v.content.slice(0, 200)}...`).join('\n\n---\n\n');
      return jsonRpc(body.id, { content: [{ type: 'text', text }] });
    }

    case 'tag_note': {
      if (!args.note_id || !args.tags || !Array.isArray(args.tags)) {
        return jsonRpc(body.id, { content: [{ type: 'text', text: 'note_id and tags (array) required.' }], isError: true });
      }
      const note = await db.prepare('SELECT id, tags FROM notes WHERE id = ? AND tenant_id = ?').bind(args.note_id, tenantId).first();
      if (!note) return jsonRpc(body.id, { content: [{ type: 'text', text: 'Note not found.' }], isError: true });
      let existingTags: string[] = [];
      try { existingTags = note.tags ? JSON.parse(note.tags as string) : []; } catch { existingTags = []; }
      const newTags = [...new Set([...existingTags, ...args.tags])];
      await db.prepare('UPDATE notes SET tags = ?, updated_at = datetime(?) WHERE id = ? AND tenant_id = ?')
        .bind(JSON.stringify(newTags), new Date().toISOString(), args.note_id, tenantId).run();
      return jsonRpc(body.id, { content: [{ type: 'text', text: `Tagged note with: ${args.tags.join(', ')}. Total tags: ${newTags.join(', ')}` }] });
    }

    case 'link_notes': {
      if (!args.source_id || !args.target_title) {
        return jsonRpc(body.id, { content: [{ type: 'text', text: 'source_id and target_title required.' }], isError: true });
      }
      const source = await db.prepare('SELECT id, content FROM notes WHERE id = ? AND tenant_id = ?').bind(args.source_id, tenantId).first();
      if (!source) return jsonRpc(body.id, { content: [{ type: 'text', text: 'Source note not found.' }], isError: true });
      const linkText = '\n\n[[' + args.target_title + ']]';
      await db.prepare('UPDATE notes SET content = content || ?, updated_at = datetime(?) WHERE id = ? AND tenant_id = ?')
        .bind(linkText, new Date().toISOString(), args.source_id, tenantId).run();
      return jsonRpc(body.id, { content: [{ type: 'text', text: `Linked to [[${args.target_title}]] from source note.` }] });
    }

    case 'merge_notes': {
      if (!args.source_id || !args.target_id) {
        return jsonRpc(body.id, { content: [{ type: 'text', text: 'source_id and target_id required.' }], isError: true });
      }
      const mergeSource = await db.prepare('SELECT id, title, content FROM notes WHERE id = ? AND tenant_id = ?').bind(args.source_id, tenantId).first();
      const mergeTarget = await db.prepare('SELECT id, content FROM notes WHERE id = ? AND tenant_id = ?').bind(args.target_id, tenantId).first();
      if (!mergeSource || !mergeTarget) return jsonRpc(body.id, { content: [{ type: 'text', text: 'One or both notes not found.' }], isError: true });
      const mergedContent = (mergeTarget.content as string) + '\n\n---\n\n## Merged from: ' + (mergeSource.title as string) + '\n\n' + (mergeSource.content as string);
      await db.prepare('UPDATE notes SET content = ?, updated_at = datetime(?) WHERE id = ? AND tenant_id = ?')
        .bind(mergedContent, new Date().toISOString(), args.target_id, tenantId).run();
      await db.prepare('DELETE FROM notes WHERE id = ? AND tenant_id = ?').bind(args.source_id, tenantId).run();
      return jsonRpc(body.id, { content: [{ type: 'text', text: `Merged "${mergeSource.title}" into target note. Source deleted.` }] });
    }

    case 'archive_note': {
      if (!args.note_id) {
        return jsonRpc(body.id, { content: [{ type: 'text', text: 'note_id required.' }], isError: true });
      }
      const archiveNote = await db.prepare('SELECT id, title FROM notes WHERE id = ? AND tenant_id = ?').bind(args.note_id, tenantId).first();
      if (!archiveNote) return jsonRpc(body.id, { content: [{ type: 'text', text: 'Note not found.' }], isError: true });
      await db.prepare("UPDATE notes SET archived = 1, updated_at = datetime(?) WHERE id = ? AND tenant_id = ?")
        .bind(new Date().toISOString(), args.note_id, tenantId).run();
      return jsonRpc(body.id, { content: [{ type: 'text', text: `Archived "${archiveNote.title}".` }] });
    }

    case 'index_notes': {
      if (!ai || !vectorize) {
        return jsonRpc(body.id, { content: [{ type: 'text', text: 'AI and Vectorize bindings required. Deploy to Cloudflare.' }], isError: true });
      }
      // Get notes to index
      let notes: any[] = [];
      if (args.note_ids && Array.isArray(args.note_ids) && args.note_ids.length > 0) {
        // Index specific notes
        for (const nid of args.note_ids.slice(0, 50)) {
          const note = await db.prepare('SELECT id, title, content FROM notes WHERE id = ? AND tenant_id = ?').bind(nid, tenantId).first();
          if (note) notes.push(note);
        }
      } else {
        // Index all notes for tenant
        const results = await db.prepare('SELECT id, title, content FROM notes WHERE tenant_id = ? AND (archived = 0 OR archived IS NULL) LIMIT 100').bind(tenantId).all();
        notes = results.results || [];
      }

      if (notes.length === 0) {
        return jsonRpc(body.id, { content: [{ type: 'text', text: 'No notes found to index.' }] });
      }

      let indexed = 0;
      for (const note of notes) {
        if (note.content && note.content.length >= 20) {
          await vectoriseNote(note.id, note.title, note.content, tenantId, ai, vectorize);
          indexed++;
        }
      }
      return jsonRpc(body.id, { content: [{ type: 'text', text: `Indexed ${indexed} notes for semantic search (${notes.length} total checked).` }] });
    }

    default:
      return jsonRpc(body.id, { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true });
  }
}

function jsonRpc(id: any, result: any) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'xnotepad-session' },
  });
}

function jsonRpcError(id: any, code: number, message: string) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'xnotepad-session' },
  });
}
