# xNotePadAI — MCP Server

A 13-tool MCP server that gives AI agents persistent, encrypted, searchable memory via notes.

**Endpoint:** `https://www.xnotepadai.com/api/mcp/`  
**Protocol:** MCP (Model Context Protocol) JSON-RPC over Streamable HTTP  
**Auth:** Bearer token  
**Free tier:** 1,000 calls/month

## Quick Start

```json
{
  "mcpServers": {
    "xnotepad": {
      "type": "http",
      "url": "https://www.xnotepadai.com/api/mcp/",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN_HERE"
      }
    }
  }
}
```

Get your token: https://www.xnotepadai.com/settings/ → Your MCP Token (pre-generated, ready to copy)

## Tools

| Tool | Description |
|------|-------------|
| `create_note` | Create a note (auto-tagged `agent-created`) |
| `list_notes` | List all notes with titles, sizes, dates |
| `get_note` | Get full note content by ID |
| `update_note` | Update content (agent-created notes only) |
| `delete_note` | Delete a note (agent-created only) |
| `search_notes` | Semantic search via vector embeddings |
| `ask_notes` | Ask a question — AI answers from note content |
| `get_versions` | Get version history for a note |
| `tag_note` | Add tags to a note |
| `link_notes` | Add [[wiki-links]] between notes |
| `merge_notes` | Merge two notes (source deleted after) |
| `archive_note` | Archive a note |
| `index_notes` | Vectorise notes for semantic search |

## Security Model

- **Bearer token auth** — SHA-256 hashed, stored in D1, revocable
- **Tenant isolation** — tenant ID derived from token lookup, never from client args
- **Agent sandboxing** — agents can only modify/delete notes tagged `agent-created`
- **Rate limiting** — 30 req/min per IP
- **Zero-knowledge encryption** — notes encrypted client-side with AES-256-GCM (MCP accesses unencrypted copies synced by the user)

## Use Cases

- **AI memory** — agents save research, decisions, architecture notes between sessions
- **Knowledge retrieval** — "What did I decide about auth?" → searches your notes
- **Note automation** — auto-tag, auto-link, merge duplicates, archive old notes
- **Multi-agent workflows** — one agent writes, another reads later

## Stack

- Cloudflare Workers (runtime)
- Cloudflare D1 (database)
- Cloudflare Vectorize (semantic search)
- Workers AI / Llama 3.3 70B (AI answers)

## Docs

- MCP Integration: https://www.xnotepadai.com/mcp/
- API Reference: https://www.xnotepadai.com/developers/
- Privacy: https://www.xnotepadai.com/privacy/

## License

MIT
