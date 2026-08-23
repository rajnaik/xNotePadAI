// Billing middleware — usage tracking + metered enforcement
// When billing is OFF (default), all requests pass freely.
// When billing is ON, per-tenant monthly limits are enforced.

export interface BillingResult {
  allowed: boolean;
  usage: number;
  limit: number;
  plan: string;
  billingEnabled: boolean;
  error?: string;
}

/**
 * Returns the current billing period string (YYYY-MM).
 */
function getCurrentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Check whether a tenant is allowed to make an API call.
 * If billing is OFF globally → always allowed (free mode).
 * If billing is ON → check tenant's usage against their plan limit.
 * Always increments usage counter (for tracking even when billing is off).
 */
export async function checkAndTrackUsage(
  db: any,
  tenantId: string,
  endpoint: string = 'mcp'
): Promise<BillingResult> {
  if (!db) {
    // No DB = can't enforce — allow (fail open for dev)
    return { allowed: true, usage: 0, limit: 0, plan: 'free', billingEnabled: false };
  }

  const period = getCurrentPeriod();

  // 1. Check global billing toggle
  const globalConfig = await db.prepare(
    "SELECT billing_enabled FROM billing_config WHERE tenant_id = '__global__'"
  ).first();

  const billingEnabled = globalConfig?.billing_enabled === 1;

  // 2. Get tenant-specific plan (falls back to global defaults)
  let plan = 'free';
  let monthlyLimit = 1000;

  const tenantConfig = await db.prepare(
    "SELECT plan, monthly_limit FROM billing_config WHERE tenant_id = ?"
  ).bind(tenantId).first();

  if (tenantConfig) {
    plan = tenantConfig.plan || 'free';
    monthlyLimit = tenantConfig.monthly_limit || 1000;
  }

  // 3. Get current usage count
  const usageRow = await db.prepare(
    "SELECT call_count FROM api_usage WHERE tenant_id = ? AND period = ? AND endpoint = ?"
  ).bind(tenantId, period, endpoint).first();

  const currentUsage = usageRow?.call_count || 0;

  // 4. Increment usage (always — even when billing is off, for analytics)
  await db.prepare(
    `INSERT INTO api_usage (tenant_id, period, endpoint, call_count, last_call_at)
     VALUES (?, ?, ?, 1, datetime('now'))
     ON CONFLICT(tenant_id, period, endpoint)
     DO UPDATE SET call_count = call_count + 1, last_call_at = datetime('now')`
  ).bind(tenantId, period, endpoint).run().catch(() => {});

  // 5. If billing is OFF → always allow (but we still tracked)
  if (!billingEnabled) {
    return { allowed: true, usage: currentUsage + 1, limit: monthlyLimit, plan, billingEnabled: false };
  }

  // 6. Billing is ON — enforce limit
  if (currentUsage >= monthlyLimit) {
    return {
      allowed: false,
      usage: currentUsage,
      limit: monthlyLimit,
      plan,
      billingEnabled: true,
      error: `Monthly API limit reached (${currentUsage}/${monthlyLimit}). Upgrade your plan or wait until next month.`,
    };
  }

  return { allowed: true, usage: currentUsage + 1, limit: monthlyLimit, plan, billingEnabled: true };
}

/**
 * Get usage stats for a tenant (for the settings UI / admin).
 */
export async function getUsageStats(db: any, tenantId: string): Promise<{
  currentPeriod: string;
  callCount: number;
  limit: number;
  plan: string;
  billingEnabled: boolean;
}> {
  if (!db) return { currentPeriod: getCurrentPeriod(), callCount: 0, limit: 1000, plan: 'free', billingEnabled: false };

  const period = getCurrentPeriod();

  const globalConfig = await db.prepare(
    "SELECT billing_enabled FROM billing_config WHERE tenant_id = '__global__'"
  ).first();

  const tenantConfig = await db.prepare(
    "SELECT plan, monthly_limit FROM billing_config WHERE tenant_id = ?"
  ).bind(tenantId).first();

  const usageRow = await db.prepare(
    "SELECT call_count FROM api_usage WHERE tenant_id = ? AND period = ? AND endpoint = 'mcp'"
  ).bind(tenantId, period).first();

  return {
    currentPeriod: period,
    callCount: usageRow?.call_count || 0,
    limit: tenantConfig?.monthly_limit || 1000,
    plan: tenantConfig?.plan || 'free',
    billingEnabled: globalConfig?.billing_enabled === 1,
  };
}
