import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseGhRunLog, robustJobLogs } from '../src/main/github/services/workflows';
import type { GitHubClient } from '../src/main/github/client/GitHubClient';
import { readZip } from '../src/main/util/zip';

/** Builds a small ZIP (deflate for odd entries, stored for even) — enough to exercise the reader. */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, content], i) => {
    const raw = Buffer.from(content, 'utf8');
    const method = i % 2 === 0 ? 8 : 0;
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const ARCHIVE = makeZip({
  '0_deploy.txt': 'whole job log',
  'deploy/1_Set up job.txt': '2024-01-01T00:00:01.000Z Runner ready',
  'deploy/2_Checkout code.txt': '2024-01-01T00:00:02.000Z Checked out',
  'deploy/3_Deploy to QA App Engine.txt': '2024-01-01T00:00:03.000Z ##[group]Run echo "🚀"\n2024-01-01T00:00:04.000Z Tag: 1.281.0\n2024-01-01T00:00:05.000Z ##[error]boom',
  '1_build.txt': 'other job',
});

describe('ZIP reader', () => {
  it('reads stored and deflated entries', () => {
    const e = readZip(ARCHIVE);
    expect(e.map((x) => x.name)).toContain('deploy/3_Deploy to QA App Engine.txt');
    expect(e.find((x) => x.name === 'deploy/2_Checkout code.txt')!.read().toString()).toContain('Checked out');
    expect(e.find((x) => x.name === 'deploy/3_Deploy to QA App Engine.txt')!.read().toString()).toContain('🚀');
  });
  it('rejects non-zip data', () => {
    expect(() => readZip(Buffer.from('not a zip at all, definitely not'))).toThrow();
  });
});

describe('job log fallbacks', () => {
  const r = { owner: 'o', name: 'n' };
  const client = (job: () => Promise<{ text: string; truncated: boolean }>, archive: () => Promise<Buffer>) =>
    ({ downloadText: job, downloadBytes: archive }) as unknown as GitHubClient;

  it('uses the job log when it works', async () => {
    const res = await robustJobLogs(client(async () => ({ text: 'hello', truncated: false }), async () => ARCHIVE), r, { jobId: 1, runId: 2, jobName: 'deploy' });
    expect(res.source).toBe('job');
    expect(res.steps).toBeNull();
  });

  it('falls back to the run archive with exact per-step files', async () => {
    const res = await robustJobLogs(
      client(
        async () => {
          throw new Error('Logs Download Failed');
        },
        async () => ARCHIVE,
      ),
      r,
      { jobId: 1, runId: 2, jobName: 'deploy' },
    );
    expect(res.source).toBe('archive');
    expect(res.steps!.map((s) => [s.number, s.name])).toEqual([
      [1, 'Set up job'],
      [2, 'Checkout code'],
      [3, 'Deploy to QA App Engine'],
    ]);
    expect(res.note).toContain('Logs Download Failed');
  });

  it('falls back to the GitHub CLI last, and explains every failure when all fail', async () => {
    const fail = async () => {
      throw new Error('nope');
    };
    const cli = async () => 'deploy\tSet up job\t2024-01-01T00:00:01Z ready\ndeploy\tDeploy to QA App Engine\t2024-01-01T00:00:03Z Tag: 1.281.0\ndeploy\tDeploy to QA App Engine\t2024-01-01T00:00:04Z done';
    const res = await robustJobLogs(client(fail, fail), r, { jobId: 1, runId: 2, jobName: 'deploy' }, cli);
    expect(res.source).toBe('gh-cli');
    expect(res.steps!.map((s) => s.name)).toEqual(['Set up job', 'Deploy to QA App Engine']);
    await expect(robustJobLogs(client(fail, fail), r, { jobId: 1, runId: 2, jobName: 'deploy' }, fail)).rejects.toMatchObject({ friendly: { code: 'logs-unavailable' } });
  });

  it('parses gh run view --log output by step', () => {
    expect(parseGhRunLog('j\tA\tx 1\nj\tA\tx 2\nj\tB\tx 3\n')).toEqual([
      { name: 'A', text: 'x 1\nx 2' },
      { name: 'B', text: 'x 3' },
    ]);
  });
});
