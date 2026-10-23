import { buildChatRequest } from './capability.js';
import { AnthropicMessagesAdapter, OpenAIChatAdapter } from './providers/index.js';
import type {
  CapabilityProfile,
  ModelConnection,
  ProbeCheck,
  ProbeResult,
} from './types.js';

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Apply the user-editable parts of a connection to a capability profile.
 * The profile controls the effort dialect; the connection controls identity.
 */
export function withConnection(
  profile: CapabilityProfile,
  connection: ModelConnection
): CapabilityProfile {
  return {
    ...profile,
    baseUrl: connection.baseUrl,
    model: connection.model,
    protocol: connection.protocol,
  };
}

/**
 * First-connect conformance probe. Sends one minimal chat request and reports
 * reachability, streaming and usage. Tool/JSON/effort probes are added once the
 * provider matrix has fixtures; unknown capabilities stay unknown rather than
 * being assumed.
 *
 * Keys must be passed by the server/CLI from the vault, never by the browser.
 */
export async function probeConnection(
  profile: CapabilityProfile,
  apiKey: string,
  options: ProbeOptions = {}
): Promise<ProbeResult> {
  const started = Date.now();
  const checks: ProbeCheck[] = [];
  let text = '';
  let reasoning = '';
  let sawUsage = false;
  let error: string | undefined;

  try {
    const adapter =
      profile.protocol === 'anthropic-messages'
        ? new AnthropicMessagesAdapter(options.fetchImpl)
        : new OpenAIChatAdapter(options.fetchImpl);

    const request = buildChatRequest(
      profile,
      [{ role: 'user', content: 'Reply with exactly: ok' }],
      'off',
      { apiKey, maxTokens: 512, signal: options.signal }
    );

    for await (const event of adapter.stream(request)) {
      if (event.type === 'text-delta') {
        text += event.text;
      } else if (event.type === 'reasoning-delta') {
        reasoning += event.text;
      } else if (event.type === 'usage') {
        sawUsage = true;
      } else if (event.type === 'error') {
        error = `${event.code}: ${event.message}`;
        break;
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const latencyMs = Date.now() - started;
  const streamed = text.trim().length > 0 || reasoning.trim().length > 0;

  checks.push({
    name: 'reachable',
    ok: !error,
    detail: error,
  });
  checks.push({
    name: 'streaming',
    ok: streamed,
    detail: streamed ? undefined : 'no text or reasoning delta received',
  });
  checks.push({
    name: 'text',
    ok: text.trim().length > 0,
    detail: text ? undefined : 'stream carried reasoning but no final text',
  });
  checks.push({
    name: 'reasoning',
    ok: reasoning.trim().length > 0,
    detail: reasoning ? undefined : 'no reasoning delta',
  });
  checks.push({
    name: 'usage',
    ok: sawUsage,
    detail: sawUsage ? undefined : 'provider did not report usage',
  });

  return {
    ok: !error && streamed,
    latencyMs,
    checks,
    error,
  };
}

/**
 * Remove secrets from any string before it reaches a log, event payload,
 * export bundle or bug report.
 */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let output = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    output = output.split(secret).join('[redacted]');
  }
  return output
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]');
}
