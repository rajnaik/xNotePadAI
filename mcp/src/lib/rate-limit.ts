/**
 * IP-based rate limiter using D1.
 * Returns true if the request is allowed, false if rate-limited.
 * 
 * Default: 60 requests per minute per IP per endpoint.
 */
export async function checkRateLimit(
  db: any,
  request: Request,
  endpoint: string,
  maxRequests: number = 60,
  windowMs: number = 60000
): Promise<{ allowed: boolean; remaining: number }> {
  if (!db) return { allowed: true, remaining: maxRequests }; // fail open if no DB

  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const windowStart = new Date(Date.now() - windowMs).toISOString();

  try {
    // Count requests in the current window
    const result = await db.prepare(
      'SELECT COUNT(*) as cnt FROM rate_limits WHERE ip = ? AND endpoint = ? AND requested_at > ?'
    ).bind(ip, endpoint, windowStart).first() as any;

    const count = result?.cnt || 0;

    if (count >= maxRequests) {
      return { allowed: false, remaining: 0 };
    }

    // Log this request (best-effort, non-blocking)
    db.prepare("INSERT INTO rate_limits (ip, endpoint, requested_at) VALUES (?, ?, datetime('now'))")
      .bind(ip, endpoint).run().catch(() => {});

    return { allowed: true, remaining: maxRequests - count - 1 };
  } catch {
    // If rate_limits table doesn't exist yet, allow the request (fail open)
    return { allowed: true, remaining: maxRequests };
  }
}

/**
 * Returns a 429 Too Many Requests response
 */
export function rateLimitResponse(endpoint: string): Response {
  return new Response(
    JSON.stringify({ error: 'Rate limit exceeded. Please try again later.', endpoint }),
    { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } }
  );
}
