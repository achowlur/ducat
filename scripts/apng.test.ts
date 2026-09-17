import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { assembleApng, readChunks } from './apng';

/** A tiny solid-colour RGB PNG, built by hand so the test needs no image library. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // RGB
  const rows = Buffer.concat(
    Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgb).flat())])),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('assembleApng', () => {
  const red = solidPng(4, 3, [200, 40, 40]);
  const blue = solidPng(4, 3, [40, 40, 200]);

  it('writes one animation control, a frame control per frame, and sequence numbers without gaps', () => {
    const apng = assembleApng([
      { png: red, delayMs: 1500 },
      { png: blue, delayMs: 400 },
    ]);
    const chunks = readChunks(apng);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'IEND']);
    const actl = chunks.find((c) => c.type === 'acTL')!.data;
    expect(actl.readUInt32BE(0)).toBe(2);
    const sequences = chunks
      .filter((c) => c.type === 'fcTL' || c.type === 'fdAT')
      .map((c) => c.data.readUInt32BE(0));
    expect(sequences).toEqual([0, 1, 2]);
    const delays = chunks.filter((c) => c.type === 'fcTL').map((c) => c.data.readUInt16BE(20) / c.data.readUInt16BE(22));
    expect(delays).toEqual([1.5, 0.4]);
  });

  it('reuses each frame’s compressed pixels unchanged', () => {
    const apng = assembleApng([{ png: red, delayMs: 100 }, { png: blue, delayMs: 100 }]);
    const blueIdat = readChunks(blue).find((c) => c.type === 'IDAT')!.data;
    const fdat = readChunks(apng).find((c) => c.type === 'fdAT')!.data;
    expect(fdat.subarray(4).equals(blueIdat)).toBe(true);
  });

  it('writes chunks whose checksums verify, so a viewer will open the file', () => {
    const apng = assembleApng([{ png: red, delayMs: 100 }, { png: blue, delayMs: 100 }]);
    for (let at = 8; at < apng.length; ) {
      const length = apng.readUInt32BE(at);
      const body = apng.subarray(at + 4, at + 8 + length);
      expect(apng.readUInt32BE(at + 8 + length)).toBe(crc32(body) >>> 0);
      at += 12 + length;
    }
  });

  it('refuses frames of different sizes rather than writing a file that will not play', () => {
    expect(() => assembleApng([{ png: red, delayMs: 100 }, { png: solidPng(5, 3, [0, 0, 0]), delayMs: 100 }])).toThrow(
      /differs from frame 0/,
    );
  });
});
