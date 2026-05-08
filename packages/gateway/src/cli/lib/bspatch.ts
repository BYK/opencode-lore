/**
 * Streaming TRDIFF10 Binary Patch Application
 *
 * Implements the bspatch algorithm for applying binary delta patches in the
 * TRDIFF10 format (produced by zig-bsdiff with `--use-zstd`). Designed for
 * minimal memory usage during CLI self-upgrades:
 *
 * - Old binary: copy-then-mmap for 0 JS heap (CoW on btrfs/xfs/APFS),
 *   falling back to `arrayBuffer()` if copy/mmap fails
 * - Diff/extra blocks: streamed via `DecompressionStream('zstd')`
 * - Output: written incrementally to disk via `Bun.file().writer()`
 * - Integrity: SHA-256 computed inline via `Bun.CryptoHasher`
 *
 * TRDIFF10 format (from zig-bsdiff):
 * ```
 * [0..8]   magic: "TRDIFF10"
 * [8..16]  controlLen: i64 LE (compressed size of control block)
 * [16..24] diffLen:    i64 LE (compressed size of diff block)
 * [24..32] newSize:    i64 LE (expected output size)
 * [32..]   zstd(control) | zstd(diff) | zstd(extra)
 * ```
 *
 * Adapted from Sentry CLI's bspatch.ts — pure Bun, no external dependencies.
 */

import { constants, copyFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** TRDIFF10 header magic bytes */
const TRDIFF10_MAGIC = "TRDIFF10";

/** Header size in bytes (magic + 3 x i64) */
const HEADER_SIZE = 32;

/** Parsed TRDIFF10 header fields */
export type PatchHeader = {
  controlLen: number;
  diffLen: number;
  newSize: number;
};

/**
 * Read a signed 64-bit little-endian integer using the zig-bsdiff encoding.
 *
 * The sign is stored in bit 7 of byte 7 (the MSB of the last byte).
 * The magnitude is in the lower 63 bits, read as unsigned LE.
 * This differs from standard two's complement — it uses sign-magnitude.
 */
export function offtin(buf: Uint8Array, offset: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
  const lo = view.getUint32(0, true);
  const hi = view.getUint32(4, true);

  const magnitude = (hi % 0x80_00_00_00) * 0x1_00_00_00_00 + lo;

  if (magnitude !== 0 && hi >= 0x80_00_00_00) {
    return -magnitude;
  }
  return magnitude;
}

/**
 * Parse and validate a TRDIFF10 patch header.
 */
export function parsePatchHeader(patch: Uint8Array): PatchHeader {
  if (patch.byteLength < HEADER_SIZE) {
    throw new Error(
      `Patch too small: ${patch.byteLength} bytes (need at least ${HEADER_SIZE})`,
    );
  }

  const magic = new TextDecoder().decode(patch.subarray(0, 8));
  if (magic !== TRDIFF10_MAGIC) {
    throw new Error(`Invalid patch format: expected TRDIFF10, got "${magic}"`);
  }

  const controlLen = offtin(patch, 8);
  const diffLen = offtin(patch, 16);
  const newSize = offtin(patch, 24);

  if (controlLen < 0 || diffLen < 0 || newSize < 0) {
    throw new Error("Corrupt patch: negative length in header");
  }

  const totalCompressed = HEADER_SIZE + controlLen + diffLen;
  if (totalCompressed > patch.byteLength) {
    throw new Error(
      `Corrupt patch: header lengths (${totalCompressed}) exceed file size (${patch.byteLength})`,
    );
  }

  return { controlLen, diffLen, newSize };
}

/**
 * Buffered reader over a `ReadableStream` that serves exact byte counts.
 */
class BufferedStreamReader {
  private readonly chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  async read(n: number): Promise<Uint8Array> {
    while (this.buffered < n && !this.done) {
      const result = await this.reader.read();
      if (result.done) {
        this.done = true;
        break;
      }
      this.chunks.push(result.value);
      this.buffered += result.value.byteLength;
    }

    if (this.buffered < n) {
      throw new Error(
        `Unexpected end of stream: needed ${n} bytes, have ${this.buffered}`,
      );
    }

    const output = new Uint8Array(n);
    let written = 0;

    while (written < n) {
      const front = this.chunks[0];
      if (!front) break;
      const needed = n - written;

      if (front.byteLength <= needed) {
        output.set(front, written);
        written += front.byteLength;
        this.buffered -= front.byteLength;
        this.chunks.shift();
      } else {
        output.set(front.subarray(0, needed), written);
        this.chunks[0] = front.subarray(needed);
        this.buffered -= needed;
        written = n;
      }
    }

    return output;
  }
}

/**
 * Create a streaming zstd decompressor from a compressed buffer.
 */
function createZstdStreamReader(compressed: Uint8Array): BufferedStreamReader {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed);
      controller.close();
    },
  });

  // Bun supports 'zstd' but the standard CompressionFormat type doesn't include it.
  // The double cast works around TypeScript's strict WritableStream<BufferSource>
  // vs WritableStream<Uint8Array> mismatch in DecompressionStream.
  const decompressed = input.pipeThrough(
    new DecompressionStream("zstd" as "deflate") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );

  return new BufferedStreamReader(
    decompressed.getReader() as ReadableStreamDefaultReader<Uint8Array>,
  );
}

type OldFileHandle = {
  data: Uint8Array;
  cleanup: () => void | Promise<void>;
};

/**
 * Load the old binary for read access during patching.
 *
 * Strategy: copy to temp file, then try mmap on the copy. Falls back to
 * arrayBuffer() if copy or mmap fails.
 */
let loadCounter = 0;

async function loadOldBinary(oldPath: string): Promise<OldFileHandle> {
  loadCounter += 1;
  const tempCopy = join(
    tmpdir(),
    `lore-patch-old-${process.pid}-${loadCounter}`,
  );
  try {
    copyFileSync(oldPath, tempCopy, constants.COPYFILE_FICLONE);
    const data = Bun.mmap(tempCopy, { shared: false });
    return {
      data,
      cleanup: () =>
        unlink(tempCopy).catch(() => {
          /* Best-effort */
        }),
    };
  } catch {
    await unlink(tempCopy).catch(() => {
      /* May not exist */
    });
    return {
      data: new Uint8Array(await Bun.file(oldPath).arrayBuffer()),
      cleanup: () => {},
    };
  }
}

/**
 * Apply a TRDIFF10 binary patch with streaming I/O for minimal memory usage.
 *
 * @param oldPath - Path to the existing (old) binary file
 * @param patchData - Complete TRDIFF10 patch file contents
 * @param destPath - Path to write the patched (new) binary
 * @returns SHA-256 hex digest of the written output
 */
export async function applyPatch(
  oldPath: string,
  patchData: Uint8Array,
  destPath: string,
): Promise<string> {
  const { controlLen, diffLen, newSize } = parsePatchHeader(patchData);

  const controlStart = HEADER_SIZE;
  const diffStart = controlStart + controlLen;
  const extraStart = diffStart + diffLen;

  // Control block is tiny — decompress fully for random access
  const controlBlock = Bun.zstdDecompressSync(
    patchData.subarray(controlStart, diffStart),
  );

  // Diff and extra blocks are streamed
  const diffReader = createZstdStreamReader(
    patchData.subarray(diffStart, extraStart),
  );
  const extraReader = createZstdStreamReader(patchData.subarray(extraStart));

  const { data: oldFile, cleanup: cleanupOldFile } =
    await loadOldBinary(oldPath);

  const writer = Bun.file(destPath).writer();
  const hasher = new Bun.CryptoHasher("sha256");

  let oldpos = 0;
  let newpos = 0;

  try {
    for (
      let controlPos = 0;
      controlPos < controlBlock.byteLength;
      controlPos += 24
    ) {
      const readDiffBy = offtin(controlBlock, controlPos);
      const readExtraBy = offtin(controlBlock, controlPos + 8);
      const seekBy = offtin(controlBlock, controlPos + 16);

      // Step 1: Read diff bytes and add to old file bytes (wrapping u8 add)
      if (readDiffBy > 0) {
        const diffChunk = await diffReader.read(readDiffBy);
        const outputChunk = new Uint8Array(readDiffBy);

        for (let i = 0; i < readDiffBy; i++) {
          outputChunk[i] =
            ((oldFile[oldpos + i] ?? 0) + (diffChunk[i] ?? 0)) % 256;
        }

        writer.write(outputChunk);
        hasher.update(outputChunk);
        oldpos += readDiffBy;
        newpos += readDiffBy;
      }

      // Step 2: Copy extra bytes directly to output
      if (readExtraBy > 0) {
        const extraChunk = await extraReader.read(readExtraBy);
        writer.write(extraChunk);
        hasher.update(extraChunk);
        newpos += readExtraBy;
      }

      // Step 3: Seek old file position
      oldpos += seekBy;
    }
  } finally {
    try {
      await writer.end();
    } finally {
      await cleanupOldFile();
    }
  }

  if (newpos !== newSize) {
    throw new Error(
      `Output size mismatch: wrote ${newpos} bytes, expected ${newSize}`,
    );
  }

  return hasher.digest("hex") as string;
}
