import * as fs from 'fs';

const EVENTS_API_URL = 'https://events.pagerduty.com/v2/enqueue';

export type Severity = 'critical' | 'error' | 'warning' | 'info';

export interface IncidentResult {
  status: string;
  message: string;
  dedupKey: string;
}

function getRoutingKey(): string | null {
  const configPath = process.env.DAEMON_CONFIG_FILE || './config.json';
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return parsed.pagerduty?.routing_key ?? null;
  } catch {
    return null;
  }
}

export async function triggerIncident(
  summary: string,
  severity: Severity = 'critical',
  dedupKey?: string,
  details?: Record<string, unknown>
): Promise<IncidentResult | null> {
  const routingKey = getRoutingKey();
  if (!routingKey) {
    console.warn(`PagerDuty not configured — would have triggered: ${summary}`);
    return null;
  }

  const payload: Record<string, unknown> = {
    routing_key: routingKey,
    event_action: 'trigger',
    payload: {
      summary,
      severity,
      source: 'waverly-daemon',
      ...(details ? { custom_details: details } : {}),
    },
  };
  if (dedupKey) {
    payload.dedup_key = dedupKey;
  }

  const response = await fetch(EVENTS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PagerDuty trigger failed: ${response.status} ${body}`);
  }

  const result = await response.json() as { status: string; message: string; dedup_key: string };
  return { status: result.status, message: result.message, dedupKey: result.dedup_key };
}

export async function resolveIncident(dedupKey: string): Promise<IncidentResult | null> {
  const routingKey = getRoutingKey();
  if (!routingKey) return null;

  const response = await fetch(EVENTS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      routing_key: routingKey,
      event_action: 'resolve',
      dedup_key: dedupKey,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PagerDuty resolve failed: ${response.status} ${body}`);
  }

  const result = await response.json() as { status: string; message: string; dedup_key: string };
  return { status: result.status, message: result.message, dedupKey: result.dedup_key };
}
