// Minimal read-only ZIP reader (stored + deflate) for GitHub's run-log archives. No dependency: entries are
// located through the central directory and inflated with Node's zlib. Sizes are capped by the caller.
import * as zlib from 'node:zlib';

export interface ZipEntry {
  name: string;
  size: number;
  read(): Buffer;
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

export function readZip(buf: Buffer, maxEntryBytes = 32 * 1024 * 1024): ZipEntry[] {
  // End of central directory: last 22 bytes + up to 64 KB comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new Error('Corrupt ZIP central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    out.push({
      name,
      size: usize,
      read() {
        if (buf.readUInt32LE(local) !== LOC) throw new Error(`Corrupt ZIP entry ${name}`);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + csize);
        if (method === 0) return Buffer.from(data.subarray(0, maxEntryBytes));
        if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: maxEntryBytes });
        throw new Error(`Unsupported ZIP compression (${method}) for ${name}`);
      },
    });
  }
  return out;
}
