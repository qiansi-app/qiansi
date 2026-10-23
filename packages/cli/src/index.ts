import { readFileSync } from 'node:fs';
import {
  probeConnection,
  redactSecrets,
  type CapabilityProfile,
  type Protocol,
} from '@qiansi/engine';

const args = process.argv.slice(2);
const command = args[0];
const file = args[1];

if (command !== 'probe' || !file) {
  console.error('Usage: qiansi probe <connection.json>');
  process.exit(2);
}

let config: Record<string, unknown>;
try {
  config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
} catch (error) {
  console.error(
    `Cannot read ${file}:`,
    error instanceof Error ? error.message : String(error)
  );
  process.exit(2);
}

const protocol: Protocol =
  config.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-chat';
const apiKeyEnv = typeof config.apiKeyEnv === 'string' ? config.apiKeyEnv : '';
const apiKey = String(apiKeyEnv ? process.env[apiKeyEnv] ?? '' : config.apiKey ?? '');

const profile: CapabilityProfile = {
  id: 'cli-probe',
  label: String(config.label ?? 'cli-probe'),
  provider: String(config.provider ?? 'custom'),
  protocol,
  baseUrl: String(config.baseUrl ?? ''),
  model: String(config.model ?? ''),
  contextWindow: 128000,
  maxOutput: 8192,
  modalities: { tools: true, json: true },
  effort: { dialect: 'none', canDisable: true },
  domesticReachable: true,
};

if (!profile.baseUrl || !profile.model) {
  console.error('baseUrl and model are required');
  process.exit(2);
}

const result = await probeConnection(profile, apiKey);
console.log(
  JSON.stringify(
    {
      ...result,
      error: result.error ? redactSecrets(result.error, [apiKey]) : undefined,
    },
    null,
    2
  )
);
process.exit(result.ok ? 0 : 1);
