import { describe, expect, it } from 'vitest';
import { parseIncluded } from '../src/main/github/client/ghTransport';

describe('gh api --include parsing', () => {
  it('reads status, headers and body (CRLF and LF)', () => {
    const r = parseIncluded(Buffer.from('HTTP/2.0 200 OK\r\nLink: <https://x?page=2>; rel="next"\r\nX-Ratelimit-Remaining: 10\r\n\r\n{"a":1}'))!;
    expect(r.status).toBe(200);
    expect(r.headers.get('link')).toContain('rel="next"');
    expect(r.body.toString()).toBe('{"a":1}');
    const nf = parseIncluded(Buffer.from('HTTP/2.0 404 Not Found\nContent-Type: application/json\n\n{"message":"Not Found"}'))!;
    expect(nf.status).toBe(404);
    expect(JSON.parse(nf.body.toString()).message).toBe('Not Found');
  });
  it('returns null for output without a status line', () => {
    expect(parseIncluded(Buffer.from('gh: not logged in'))).toBeNull();
  });
});
