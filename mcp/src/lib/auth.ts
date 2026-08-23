// Centralised token validation — all authenticated endpoints use this
// Validates token against mcp_tokens table in D1 (hash-based, revocation-aware)

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export interface AuthResult {
  valid: boolean;
  tenantId?: string;
  appName?: string;
  error?: string;
}

/**
 * Validates a Bearer token from the request against the mcp_tokens D1 table.
 * Returns tenant info if valid, or error details if not.
 * 
 * Falls back to accepting the user's primary API token (xnotepad-api-token)
 * by checking against the special app_name='__primary__' row.
 */
export async function requireToken(request: Request, db: any): Promise<AuthResult> {
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();

  // Basic format check
  if (!token || token.length < 36) {
    return { valid: false, error: 'Authentication required. Pass Authorization: Bearer <token> header.' };
  }

  // If no DB available — fail closed (cannot validate)
  if (!db) {
    return { valid: false, error: 'Authentication service unavailable. Deploy to Cloudflare with D1 binding.' };
  }

  // Hash and lookup
  const tokenHash = await hashToken(token);
  const row = await db.prepare(
    'SELECT id, app_name, tenant_id FROM mcp_tokens WHERE token_hash = ? AND revoked = 0'
  ).bind(tokenHash).first();

  if (!row) {
    return { valid: false, error: 'Invalid or revoked token. Generate a new token in Settings > Connected Apps.' };
  }

  // Update last_used_at (non-blocking)
  db.prepare("UPDATE mcp_tokens SET last_used_at = datetime('now') WHERE id = ?").bind(row.id).run().catch(() => {});

  return { valid: true, tenantId: row.tenant_id || '', appName: row.app_name || '' };
}
