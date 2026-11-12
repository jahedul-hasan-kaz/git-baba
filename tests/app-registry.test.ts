import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRegistry } from '../src/main/accounts/AppRegistry';
import { SecretStore, type Encryptor } from '../src/main/repositories/SecretStore';

const enc: Encryptor = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(`enc:${s}`),
  decrypt: (b) => b.toString().replace(/^enc:/, ''),
};

let dir = '';
afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

describe('AppRegistry', () => {
  it('stores App metadata in clear and the key encrypted, and survives a restart', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-apps-'));
    const file = path.join(dir, 'apps.json');
    const keys = path.join(dir, 'keys');
    const r = new AppRegistry(file, keys, enc);
    const app = r.upsert({ appId: '42', name: 'Deployer', slug: 'deployer', owner: 'me', apiBase: 'https://api.github.com', htmlUrl: 'https://github.com/apps/deployer', permissions: { contents: 'write' }, events: [] }, 'PEM-DATA');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('PEM-DATA');
    expect(fs.readFileSync(path.join(keys, `${app.id}.bin`)).toString()).toBe('enc:PEM-DATA');

    const again = new AppRegistry(file, keys, enc);
    expect(again.list()).toHaveLength(1);
    expect(again.get(app.id)?.hasKey).toBe(true);
    expect(again.getKey(app.id)).toBe('PEM-DATA');
    // Re-registering the same App keeps its id.
    expect(again.upsert({ ...again.get(app.id)!, name: 'Deployer 2' }, 'PEM-2').id).toBe(app.id);
    again.remove(app.id);
    expect(again.list()).toHaveLength(0);
    expect(fs.existsSync(path.join(keys, `${app.id}.bin`))).toBe(false);
  });

  it('lets a linked repository use the account App key, while its own saved key still wins', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-apps-'));
    const secrets = new SecretStore(path.join(dir, 'secrets'), enc);
    const linked = new Set(['repoLinked']);
    secrets.linkedAppKey = (id) => (linked.has(id) ? 'ACCOUNT-KEY' : null);
    expect(secrets.getGitHubAppKey('repoLinked')).toBe('ACCOUNT-KEY');
    expect(secrets.status('repoLinked').githubAppKey).toBe(true);
    expect(secrets.getGitHubAppKey('repoOther')).toBeNull();
    secrets.saveGitHubAppKey('repoLinked', 'REPO-KEY');
    expect(secrets.getGitHubAppKey('repoLinked')).toBe('REPO-KEY');
  });
});
