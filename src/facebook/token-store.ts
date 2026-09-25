import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Entry } from '@napi-rs/keyring';

export type TokenKey = 'user' | `page:${string}`;

/** Where Facebook tokens live. Never the database, CSV or logs. */
export interface TokenStore {
  readonly kind: 'keychain' | 'file' | 'memory';
  get(key: TokenKey): string | undefined;
  set(key: TokenKey, value: string): void;
  delete(key: TokenKey): void;
}

const SERVICE = 'reel-cli';

export class KeychainTokenStore implements TokenStore {
  readonly kind = 'keychain';
  get(key: TokenKey): string | undefined {
    return new Entry(SERVICE, key).getPassword() ?? undefined;
  }
  set(key: TokenKey, value: string): void {
    new Entry(SERVICE, key).setPassword(value);
  }
  delete(key: TokenKey): void {
    try {
      new Entry(SERVICE, key).deletePassword();
    } catch {
      // already absent
    }
  }
}

/** Fallback when no OS keychain is available: a JSON file readable only by the current user. */
export class FileTokenStore implements TokenStore {
  readonly kind = 'file';
  constructor(private readonly file: string) {}
  private read(): Record<string, string> {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>) : {};
  }
  private write(data: Record<string, string>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
  get(key: TokenKey): string | undefined {
    return this.read()[key];
  }
  set(key: TokenKey, value: string): void {
    this.write({ ...this.read(), [key]: value });
  }
  delete(key: TokenKey): void {
    const data = this.read();
    if (!(key in data)) return;
    this.write(Object.fromEntries(Object.entries(data).filter(([k]) => k !== key)));
  }
}

export class MemoryTokenStore implements TokenStore {
  readonly kind = 'memory';
  private readonly data = new Map<string, string>();
  get(key: TokenKey): string | undefined {
    return this.data.get(key);
  }
  set(key: TokenKey, value: string): void {
    this.data.set(key, value);
  }
  delete(key: TokenKey): void {
    this.data.delete(key);
  }
}

/** OS keychain if it works, otherwise a 0600 file at `fallbackFile`. */
export function createTokenStore(fallbackFile: string): TokenStore {
  try {
    const probe = new Entry(SERVICE, 'probe');
    probe.setPassword('ok');
    probe.deletePassword();
    return new KeychainTokenStore();
  } catch {
    return new FileTokenStore(fallbackFile);
  }
}
