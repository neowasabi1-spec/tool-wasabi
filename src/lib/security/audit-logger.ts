/**
 * Security event audit logger.
 * Per SOC 2 Security & Confidentiality: provides an immutable audit trail
 * for all security-relevant events.
 *
 * Logs are stored in Supabase `audit_logs` table and also written to
 * structured stdout for log aggregation services (Datadog, CloudWatch, etc.).
 */

export type AuditEventType =
  | 'AUTH_LOGIN'
  | 'AUTH_LOGOUT'
  | 'AUTH_FAILED'
  | 'AUTH_TOKEN_REFRESH'
  | 'API_ACCESS'
  | 'API_RATE_LIMITED'
  | 'API_UNAUTHORIZED'
  | 'API_FORBIDDEN'
  | 'DATA_CREATE'
  | 'DATA_READ'
  | 'DATA_UPDATE'
  | 'DATA_DELETE'
  | 'DATA_EXPORT'
  | 'SECURITY_VIOLATION'
  | 'CONFIG_CHANGE'
  | 'ADMIN_ACTION';

export type AuditSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface AuditEntry {
  event_type: AuditEventType;
  severity: AuditSeverity;
  actor_id?: string;
  actor_ip?: string;
  resource_type?: string;
  resource_id?: string;
  action: string;
  details?: Record<string, unknown>;
  user_agent?: string;
  timestamp: string;
}

function buildEntry(
  eventType: AuditEventType,
  severity: AuditSeverity,
  action: string,
  meta?: Partial<AuditEntry>
): AuditEntry {
  return {
    event_type: eventType,
    severity,
    action,
    timestamp: new Date().toISOString(),
    ...meta,
  };
}

async function persistToSupabase(entry: AuditEntry): Promise<void> {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) return;

    await fetch(`${supabaseUrl}/rest/v1/audit_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        event_type: entry.event_type,
        severity: entry.severity,
        actor_id: entry.actor_id || null,
        actor_ip: entry.actor_ip || null,
        resource_type: entry.resource_type || null,
        resource_id: entry.resource_id || null,
        action: entry.action,
        details: entry.details || {},
        user_agent: entry.user_agent || null,
      }),
    });
  } catch {
    // Never let audit logging failure break the application
  }
}

function writeToStdout(entry: AuditEntry): void {
  const logLine = JSON.stringify({
    _type: 'audit',
    ...entry,
  });
  console.log(logLine);
}

export const audit = {
  async log(
    eventType: AuditEventType,
    severity: AuditSeverity,
    action: string,
    meta?: Partial<AuditEntry>
  ): Promise<void> {
    const entry = buildEntry(eventType, severity, action, meta);
    writeToStdout(entry);
    await persistToSupabase(entry);
  },

  info(eventType: AuditEventType, action: string, meta?: Partial<AuditEntry>) {
    return this.log(eventType, 'info', action, meta);
  },

  warn(eventType: AuditEventType, action: string, meta?: Partial<AuditEntry>) {
    return this.log(eventType, 'warn', action, meta);
  },

  error(eventType: AuditEventType, action: string, meta?: Partial<AuditEntry>) {
    return this.log(eventType, 'error', action, meta);
  },

  critical(eventType: AuditEventType, action: string, meta?: Partial<AuditEntry>) {
    return this.log(eventType, 'critical', action, meta);
  },
};
