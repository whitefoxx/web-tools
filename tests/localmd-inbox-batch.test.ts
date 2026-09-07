/**
 * The capture inbox is read over a relay frame with a byte ceiling, and a
 * count-only batch does not know that. Two full-page screenshots at 9MB each
 * were "two items" and 18MB; the service worker truncated the reply to fit,
 * the reader could not parse what was left and took it for an empty inbox,
 * and every capture queued behind them stayed there (findings F-59).
 *
 * These pin the two halves of the fix: a batch is bounded by bytes and always
 * moves, and a whole page is no longer encoded as a lossless PNG.
 */
import { describe, it, expect } from 'vitest';
import {
  INBOX_BATCH_BYTES,
  LOCALMD_FRAME_BYTES,
  makeInboxItem,
  pickInboxBatch,
  type InboxItem,
} from '../src/localmd-connect/inbox';
import { FULL_PAGE_FORMAT, FULL_PAGE_QUALITY } from '../src/localmd-connect/region-shot';

function item(id: string, payloadBytes: number, createdAt: number): InboxItem {
  return {
    ...makeInboxItem('screenshot', { url: 'https://x.test/' + id, title: id, payload: null }),
    id,
    createdAt,
    payload: { dataUrl: 'x'.repeat(payloadBytes) },
  };
}

describe('pickInboxBatch', () => {
  it('returns everything when it all fits, oldest first, up to the count', () => {
    const items = [item('a', 100, 1), item('b', 100, 2), item('c', 100, 3)];
    expect(pickInboxBatch(items, 10, 10_000).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(pickInboxBatch(items, 2, 10_000).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('stops BEFORE the item that would cross the byte budget', () => {
    // Each item is ~600 bytes with its envelope; the budget holds two.
    const items = [item('a', 500, 1), item('b', 500, 2), item('c', 500, 3)];
    const two = pickInboxBatch(items, 10, 1_300);
    expect(two.map((i) => i.id)).toEqual(['a', 'b']);
    // The next call, with the first two acked, delivers the rest.
    expect(pickInboxBatch(items.slice(2), 10, 1_300).map((i) => i.id)).toEqual(['c']);
  });

  it('always returns at least one item, so the queue moves', () => {
    const items = [item('big', 5_000, 1), item('small', 10, 2)];
    // A budget the big one fits in alone, with no room for a second item.
    const budget = new TextEncoder().encode(JSON.stringify(items[0])).length + 20;
    const batch = pickInboxBatch(items, 10, budget);
    expect(batch.map((i) => i.id)).toEqual(['big']);
    expect('oversized' in batch[0]).toBe(false);
  });

  it('returns an item that cannot fit ALONE stripped and flagged, by itself', () => {
    const items = [item('huge', 50_000, 1), item('next', 10, 2)];
    const batch = pickInboxBatch(items, 10, 6_000);
    expect(batch).toHaveLength(1);
    const first = batch[0] as { id: string; oversized?: boolean; bytes?: number; payload?: unknown };
    expect(first.id).toBe('huge');
    expect(first.oversized).toBe(true);
    expect(first.bytes).toBeGreaterThan(50_000);
    expect('payload' in first).toBe(false);
  });

  it('does not strip an oversized item into a batch that already holds whole ones', () => {
    // The reader acks a batch as one; a stripped item among whole ones would
    // be acked as if delivered. It waits for its own turn instead.
    const items = [item('a', 10, 1), item('huge', 50_000, 2), item('c', 10, 3)];
    const batch = pickInboxBatch(items, 10, 6_000);
    expect(batch.map((i) => i.id)).toEqual(['a']);
  });

  it('counts bytes, not characters', () => {
    const cjk = { ...item('cjk', 0, 1), title: '知'.repeat(1_000) }; // 3 bytes each
    const ascii = { ...item('ascii', 0, 2), title: 'k'.repeat(1_000) };
    // A budget that holds the ASCII item but not the CJK one of the same LENGTH.
    const budget = 1_500;
    expect(pickInboxBatch([ascii], 10, budget)[0]).not.toHaveProperty('oversized');
    expect(pickInboxBatch([cjk], 10, budget)[0]).toHaveProperty('oversized', true);
  });

  it('keeps the batch budget well under the frame the worker will send', () => {
    // Envelope + non-payload fields + the ratio JSON.stringify adds to a data
    // URL all have to fit in the gap, or a batch built to budget still gets
    // truncated. A quarter of the frame is the margin.
    expect(INBOX_BATCH_BYTES).toBeLessThanOrEqual(LOCALMD_FRAME_BYTES * 0.75);
    expect(LOCALMD_FRAME_BYTES).toBe(16 * 1_048_576);
  });
});

describe('full-page capture encoding', () => {
  it('is lossy, and at a quality that keeps text readable', () => {
    expect(FULL_PAGE_FORMAT).toBe('webp');
    expect(FULL_PAGE_QUALITY).toBeGreaterThanOrEqual(80);
    expect(FULL_PAGE_QUALITY).toBeLessThanOrEqual(95);
  });
});
