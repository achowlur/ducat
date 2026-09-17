import { crc32 } from 'node:zlib';

/**
 * Assemble PNG frames into an animated PNG, for the README walkthrough.
 *
 * Why APNG and not a video or a GIF: a README cannot play a video from the
 * repository (GitHub only plays uploaded attachments), a GIF's 256 colours
 * band the app's sepia paper, and an APNG is still a `.png` that GitHub renders
 * inline and animates. No encoder is needed either — each frame's compressed
 * image data is reused as-is (IDAT in the first frame, fdAT after it), which is
 * exactly what the format was designed for.
 *
 * Every frame must share the first frame's IHDR (size, bit depth, colour type):
 * a mismatch is refused rather than written as a file that will not play.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Chunk {
  type: string;
  data: Buffer;
}

export function readChunks(png: Buffer): Chunk[] {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  const chunks: Chunk[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    chunks.push({ type, data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

export interface Frame {
  png: Buffer;
  /** How long this frame stays on screen. */
  delayMs: number;
}

export function assembleApng(frames: Frame[]): Buffer {
  if (frames.length === 0) throw new Error('no frames');
  const parsed = frames.map((f) => readChunks(f.png));
  const ihdr = parsed[0].find((c) => c.type === 'IHDR')!.data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  parsed.forEach((chunks, i) => {
    const own = chunks.find((c) => c.type === 'IHDR')!.data;
    if (!own.equals(ihdr)) throw new Error(`frame ${i} differs from frame 0 in size or pixel format`);
  });

  const out: Buffer[] = [SIGNATURE, chunk('IHDR', ihdr)];
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  actl.writeUInt32BE(0, 4); // loop forever
  out.push(chunk('acTL', actl));

  let sequence = 0;
  parsed.forEach((chunks, i) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(sequence++, 0);
    fctl.writeUInt32BE(width, 4);
    fctl.writeUInt32BE(height, 8);
    fctl.writeUInt32BE(0, 12); // x offset
    fctl.writeUInt32BE(0, 16); // y offset
    fctl.writeUInt16BE(Math.min(65535, Math.round(frames[i].delayMs)), 20);
    fctl.writeUInt16BE(1000, 22); // delay is in milliseconds
    fctl.writeUInt8(0, 24); // dispose: none
    fctl.writeUInt8(0, 25); // blend: source (each frame is a whole screen)
    out.push(chunk('fcTL', fctl));
    for (const c of chunks.filter((x) => x.type === 'IDAT')) {
      if (i === 0) {
        out.push(chunk('IDAT', c.data));
      } else {
        const seq = Buffer.alloc(4);
        seq.writeUInt32BE(sequence++, 0);
        out.push(chunk('fdAT', Buffer.concat([seq, c.data])));
      }
    }
  });
  out.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(out);
}
