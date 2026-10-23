import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VaultPort } from '@qiansi/engine';
import { ensureStateDir } from './state-dir.js';

interface VaultFile {
  version: 1;
  refs: Record<string, string>;
}

const stateDir = ensureStateDir();
const vaultFile = join(stateDir, 'vault.json');

const PROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($cipher)
`.trim();

const UNPROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd()
$cipher = [Convert]::FromBase64String($b64.Trim())
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Text.Encoding]::UTF8.GetString($bytes)
`.trim();

function runPowerShell(script: string, input: string): string {
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    }
  );
  return String(output).replace(/^﻿/, '').trim();
}

function protect(plain: string): string {
  return runPowerShell(PROTECT_SCRIPT, plain);
}

function unprotect(cipher: string): string {
  return runPowerShell(UNPROTECT_SCRIPT, cipher);
}

function load(): VaultFile {
  if (!existsSync(vaultFile)) return { version: 1, refs: {} };
  try {
    const parsed = JSON.parse(readFileSync(vaultFile, 'utf8')) as Partial<VaultFile>;
    return { version: 1, refs: parsed.refs ?? {} };
  } catch {
    return { version: 1, refs: {} };
  }
}

function save(data: VaultFile): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(vaultFile, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Windows DPAPI vault. Values on disk are encrypted for the current Windows
 * user; plaintext only exists in memory or in a stdin pipe to PowerShell.
 * This is not a replacement for a per-app secret: any process running as the
 * same Windows user can ask DPAPI to decrypt. It is, however, not plaintext
 * and safe from accidental commits, backups or log scraping.
 */
export class DpapiVault implements VaultPort {
  async get(ref: string): Promise<string | undefined> {
    const cipher = load().refs[ref];
    if (!cipher) return undefined;
    return unprotect(cipher);
  }

  async set(ref: string, value: string): Promise<void> {
    const data = load();
    data.refs[ref] = protect(value);
    save(data);
  }

  async remove(ref: string): Promise<void> {
    const data = load();
    delete data.refs[ref];
    save(data);
  }

  async refs(): Promise<string[]> {
    return Object.keys(load().refs);
  }
}
