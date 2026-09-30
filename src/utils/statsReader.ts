import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export type StatsCheckpoint = { offset: number; generation: string; digest: string };
export const STATS_CHUNK_BYTES = 64 * 1024;
export const STATS_RECORD_BYTES = 4 * 1024 * 1024;
export type StatsReadQuality = {
    bytesRead: number;
    parseErrors: number;
    oversizedRecords: number;
    pendingTailBytes: number;
    shortReads: number;
    changedSources: number;
};
export type StatsRecord = {
    value: unknown;
    offset: number;
    generation: string;
};
/** One parser, independent of the shared JSONL reader's tail cap and silent recovery. */
export async function readStatsRecords(path: string, consume: (record: StatsRecord) => void | Promise<void>, options: {
    chunkBytes?: number;
    maxRecordBytes?: number;
    signal?: AbortSignal;
    deadline?: number;
    continuation?: StatsCheckpoint;
    onReset?: () => void;
    onCheckpoint?: (checkpoint: StatsCheckpoint | null, continued: boolean) => void;
} = {}): Promise<StatsReadQuality> {
    const chunkBytes = options.chunkBytes ?? STATS_CHUNK_BYTES;
    const maxRecordBytes = options.maxRecordBytes ?? STATS_RECORD_BYTES;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > STATS_CHUNK_BYTES || !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0 || maxRecordBytes > STATS_RECORD_BYTES)
        throw new Error('Invalid reader limits');
    const file = await open(path, 'r');
    const quality: StatsReadQuality = { bytesRead: 0, parseErrors: 0, oversizedRecords: 0, pendingTailBytes: 0, shortReads: 0, changedSources: 0 };
    try {
        const before = await file.stat();
        const boundary = before.size;
        const generation = `${before.dev}:${before.ino}:${before.birthtimeMs}`;
        const chunk = Buffer.alloc(chunkBytes);
        let pieces: Buffer[] = [], size = 0, offset = 0, oversized = false;
        const check = () => {
            options.signal?.throwIfAborted();
            if (options.deadline !== undefined && Date.now() > options.deadline)
                throw new Error('Usage collection timeout');
        };
        // Growth and inode identity alone cannot prove append-only behavior:
        // an in-place edit followed by an append has both. Verify the previous
        // prefix on this same descriptor before retaining its projected rows.
        // This trades sequential reads for avoiding JSON projection and writes.
        let hash = createHash('sha256');
        const prior = options.continuation;
        let continued = false;
        if (prior && prior.generation === generation && Number.isSafeInteger(prior.offset) && prior.offset > 0 && prior.offset < boundary) {
            let position = 0, lastByte = -1;
            while (position < prior.offset) {
                check();
                const read = await file.read(chunk, 0, Math.min(chunk.length, prior.offset - position), position);
                if (!read.bytesRead) break;
                hash.update(chunk.subarray(0, read.bytesRead));
                lastByte = chunk[read.bytesRead - 1]!;
                position += read.bytesRead;
            }
            continued = position === prior.offset && lastByte === 10 && hash.copy().digest('hex') === prior.digest;
            if (continued) offset = quality.bytesRead = prior.offset;
        }
        if (!continued) {
            hash = createHash('sha256');
            options.onReset?.();
        }
        const finish = async (terminated: boolean) => {
            if (oversized)
                quality.oversizedRecords++;
            else if (size) {
                const line = Buffer.concat(pieces, size);
                // Decode after byte framing so a chunk split cannot corrupt UTF-8.
                let text: string;
                try {
                    text = new TextDecoder('utf-8', { fatal: true }).decode(line);
                }
                catch {
                    quality.parseErrors++;
                    text = '';
                }
                if (text.trim()) {
                    let value: unknown;
                    try {
                        value = JSON.parse(text);
                    }
                    catch (error) {
                        const incomplete = error instanceof SyntaxError && /EOF|end of JSON|unterminated/i.test(error.message);
                        if (terminated || !incomplete)
                            quality.parseErrors++;
                        else
                            quality.pendingTailBytes += size;
                        pieces = [];
                        size = 0;
                        oversized = false;
                        return;
                    }
                    await consume({ value, offset, generation });
                }
            }
            pieces = [];
            size = 0;
            oversized = false;
        };
        while (quality.bytesRead < boundary) {
            check();
            const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, boundary - quality.bytesRead), quality.bytesRead);
            if (bytesRead === 0) {
                quality.shortReads++;
                break;
            }
            hash.update(chunk.subarray(0, bytesRead));
            let start = 0;
            for (let i = 0; i < bytesRead; i++) {
                if (chunk[i] !== 10)
                    continue;
                const length = i - start;
                size += length;
                if (size > maxRecordBytes) {
                    oversized = true;
                    pieces = [];
                }
                else if (!oversized && length)
                    pieces.push(Buffer.from(chunk.subarray(start, i)));
                await finish(true);
                offset = quality.bytesRead + i + 1;
                start = i + 1;
                check();
            }
            const length = bytesRead - start;
            size += length;
            if (size > maxRecordBytes) {
                oversized = true;
                pieces = [];
            }
            else if (!oversized && length)
                pieces.push(Buffer.from(chunk.subarray(start, bytesRead)));
            quality.bytesRead += bytesRead;
        }
        if (size || oversized)
            await finish(false);
        const after = await file.stat();
        let current;
        try {
            current = await stat(path);
        }
        catch {
            quality.changedSources = 1;
        }
        if (!current || current.dev !== before.dev || current.ino !== before.ino || after.size < boundary || (after.size === boundary && after.mtimeMs !== before.mtimeMs))
            quality.changedSources = 1;
        options.onCheckpoint?.(!quality.changedSources && !quality.shortReads && offset === boundary
            ? { offset: boundary, generation, digest: hash.digest('hex') } : null, continued);
        return quality;
    }
    finally {
        await file.close();
    }
}
