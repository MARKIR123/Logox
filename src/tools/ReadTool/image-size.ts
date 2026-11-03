import {closeSync, openSync, readSync} from 'node:fs';

/** Pixel size of a PNG, GIF, JPEG or WebP read from its header; undefined when the file or format is not understood. */
export function imageSize(path: string): {width: number; height: number} | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(256 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const b = buffer.subarray(0, bytes);
    if (b.length > 24 && b.toString('latin1', 1, 4) === 'PNG') return {width: b.readUInt32BE(16), height: b.readUInt32BE(20)};
    if (b.length > 10 && b.toString('latin1', 0, 3) === 'GIF') return {width: b.readUInt16LE(6), height: b.readUInt16LE(8)};
    if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const kind = b.toString('latin1', 12, 16);
      if (kind === 'VP8X') return {width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3)};
      if (kind === 'VP8L') {const bits = b.readUInt32LE(21); return {width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff)};}
      if (kind === 'VP8 ') return {width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff};
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let at = 2;
      while (at + 9 < b.length) {
        if (b[at] !== 0xff) {at++; continue;}
        const marker = b[at + 1]!;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return {height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7)};
        at += 2 + b.readUInt16BE(at + 2);
      }
    }
  } catch {} finally {if (fd !== undefined) try {closeSync(fd);} catch {}}
  return undefined;
}
