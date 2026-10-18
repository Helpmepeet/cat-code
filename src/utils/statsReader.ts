import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { usageDeadlineFailure } from './statsFailure.js';
export type StatsCheckpoint = { offset: number; generation: string; digest: string };
export const STATS_CHUNK_BYTES = 64 * 1024;
export const STATS_RECORD_BYTES = 4 * 1024 * 1024;
const OVERSIZED_PREFIX_BYTES = 64 * 1024;
export type StatsReadQuality = {
    bytesRead: number;
    parseErrors: number;
    /** Oversized lines whose usage relevance is unknown; these make coverage partial. */
    oversizedRecords: number;
    /** Oversized user lines whose prefix shows only tool results. They carry no usage; their tool results are not counted. */
    oversizedToolResults: number;
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
    const quality: StatsReadQuality = { bytesRead: 0, parseErrors: 0, oversizedRecords: 0, oversizedToolResults: 0, pendingTailBytes: 0, shortReads: 0, changedSources: 0 };
    try {
        const before = await file.stat();
        const boundary = before.size;
        const generation = `${before.dev}:${before.ino}:${before.birthtimeMs}`;
        const chunk = Buffer.alloc(chunkBytes);
        let pieces: Buffer[] = [], size = 0, offset = 0, oversized = false, head: Buffer | undefined;
        const append = (segment: Buffer) => {
            size += segment.length;
            if (!oversized && size > maxRecordBytes) {
                oversized = true;
                head = Buffer.concat([...pieces, segment], Math.min(size, OVERSIZED_PREFIX_BYTES));
                pieces = [];
            }
            else if (!oversized && segment.length)
                pieces.push(Buffer.from(segment));
        };
        const check = () => {
            options.signal?.throwIfAborted();
            if (options.deadline !== undefined && Date.now() > options.deadline)
                throw usageDeadlineFailure('index');
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
            if (oversized) {
                if (head && oversizedToolResultPrefix(new TextDecoder('utf-8').decode(head)))
                    quality.oversizedToolResults++;
                else
                    quality.oversizedRecords++;
            }
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
                        head = undefined;
                        return;
                    }
                    await consume({ value, offset, generation });
                }
            }
            pieces = [];
            size = 0;
            oversized = false;
            head = undefined;
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
                append(chunk.subarray(start, i));
                await finish(true);
                offset = quality.bytesRead + i + 1;
                start = i + 1;
                check();
            }
            append(chunk.subarray(start, bytesRead));
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

/**
 * Decides from the start of an oversized line whether it is a user record whose
 * content is only tool results. Projection keeps nothing else from such a record,
 * and user records never carry usage. Anything the prefix cannot prove,
 * including a top-level `type` the prefix never reaches, stays unclassified.
 */
export function oversizedToolResultPrefix(text: string): boolean {
    type Frame = { array: boolean; name: string; key: string | undefined; expectKey: boolean; index: number; blockType?: string };
    const stack: Frame[] = [];
    let topType: string | undefined, toolResults = 0, i = 0;
    const path = () => stack.map(frame => frame.name).join('/');
    const inContent = () => stack.length === 3 && stack[2]!.array && path() === '/message/content';
    const value = (scalar: string | null) => {
        const frame = stack.at(-1);
        if (!frame) return;
        if (!frame.array) {
            if (stack.length === 1 && frame.key === 'type' && scalar !== null) topType = scalar;
            if (stack.length === 4 && inContentParent() && frame.key === 'type' && scalar !== null) frame.blockType = scalar;
            frame.key = undefined;
            frame.expectKey = true;
        }
        else frame.index++;
    };
    const inContentParent = () => stack.length >= 4 && stack[2]!.array && stack.slice(0, 3).map(frame => frame.name).join('/') === '/message/content';
    while (i < text.length) {
        const c = text[i]!;
        if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',' || c === ':') { i++; continue; }
        if (c === '{' || c === '[') {
            const parent = stack.at(-1);
            if (!parent && c !== '{') return false;
            if (parent && !parent.array && parent.expectKey) return false;
            const name = parent ? parent.array ? String(parent.index) : parent.key ?? '' : '';
            if (inContent() && c !== '{') return false;
            stack.push({ array: c === '[', name, key: undefined, expectKey: c === '{', index: 0 });
            i++;
            continue;
        }
        if (c === '}' || c === ']') {
            const frame = stack.pop();
            if (!frame || frame.array !== (c === ']')) return false;
            if (inContent()) {
                if (frame.blockType !== 'tool_result') return false;
                toolResults++;
            }
            value(null);
            i++;
            continue;
        }
        if (c === '"') {
            let end = i + 1, escaped = false;
            for (; end < text.length; end++) {
                if (escaped) escaped = false;
                else if (text[end] === '\\') escaped = true;
                else if (text[end] === '"') break;
            }
            if (end >= text.length) break;
            let decoded: string;
            try { decoded = JSON.parse(text.slice(i, end + 1)) as string; } catch { return false; }
            i = end + 1;
            const frame = stack.at(-1);
            if (!frame) return false;
            if (!frame.array && frame.expectKey) { frame.key = decoded; frame.expectKey = false; }
            else {
                if (inContent()) return false;
                value(decoded);
            }
            continue;
        }
        // Number or literal: skip to the next delimiter.
        let end = i;
        while (end < text.length && !',}] \n\r\t'.includes(text[end]!)) end++;
        if (end >= text.length) break;
        if (inContent()) return false;
        value(null);
        i = end;
    }
    // The block cut off by the prefix counts once its own type is known.
    const open = stack.length >= 4 && inContentParent() ? stack[3] : undefined;
    if (open?.blockType !== undefined) {
        if (open.blockType !== 'tool_result') return false;
        toolResults++;
    }
    return topType === 'user' && toolResults > 0;
}
