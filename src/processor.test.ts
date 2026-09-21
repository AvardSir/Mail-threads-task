// src/processor.test.ts

import { buildUpdates } from './processor';
import type { MessageRow } from './db';

// ---- helpers ----

const makeRow = (
    overrides: Partial<MessageRow> & { externalId: string },
): MessageRow => ({
    id: 0,
    parentId: null,
    threadKey: null,
    subject: null,
    fromAddr: null,
    toAddrs: [],
    sentAt: null,
    references: [],
    inReplyTo: null,
    ...overrides,
});

const ids = (...values: string[]): Set<string> => new Set(values);

const indexById = (rows: ReturnType<typeof buildUpdates>) =>
    new Map(rows.map((u) => [u.externalId, u]));

// ---- tests ----

describe('buildUpdates', () => {
    // ---- A. basic / boundary ----
    describe('A. basic and boundary', () => {
        test('A1: empty input → []', () => {
            expect(buildUpdates([], ids())).toEqual([]);
        });

        test('A2: single message, no links → parentId=null, threadKey="t-<id>"', () => {
            const m = makeRow({ externalId: 'm1' });
            expect(buildUpdates([m], ids('m1'))).toEqual([
                { externalId: 'm1', parentId: null, threadKey: 't-m1' },
            ]);
        });

        test('A3: inReplyTo ∈ existingIds → parentId=inReplyTo, threadKey="t-<inReplyTo>"', () => {
            const m = makeRow({ externalId: 'm1', inReplyTo: 'root' });
            expect(buildUpdates([m], ids('m1', 'root'))).toEqual([
                { externalId: 'm1', parentId: 'root', threadKey: 't-root' },
            ]);
        });

        test('A4: inReplyTo ∉ existingIds → parentId=null, threadKey="t-<dead>"', () => {
            const m = makeRow({ externalId: 'm1', inReplyTo: 'dead' });
            expect(buildUpdates([m], ids('m1'))).toEqual([
                { externalId: 'm1', parentId: null, threadKey: 't-dead' },
            ]);
        });
    });

    // ---- B. parentId selection ----
    describe('B. parentId selection (scan from the end)', () => {
        test('B1: only references[last] is known', () => {
            const m = makeRow({
                externalId: 'm1',
                references: ['r1', 'r2'],
            });
            const [u] = buildUpdates([m], ids('m1', 'r2'));
            expect(u.parentId).toBe('r2');
        });

        test('B2: inReplyTo wins over references', () => {
            const m = makeRow({
                externalId: 'm1',
                references: ['r1'],
                inReplyTo: 'r2',
            });
            const [u] = buildUpdates([m], ids('m1', 'r1', 'r2'));
            expect(u.parentId).toBe('r2');
        });

        test('B3: inReplyTo unknown → fall back to references[last]', () => {
            const m = makeRow({
                externalId: 'm1',
                references: ['r1'],
                inReplyTo: 'dead',
            });
            const [u] = buildUpdates([m], ids('m1', 'r1'));
            expect(u.parentId).toBe('r1');
        });

        test('B4: only references[0] is known', () => {
            const m = makeRow({
                externalId: 'm1',
                references: ['r1', 'r2', 'r3'],
            });
            const [u] = buildUpdates([m], ids('m1', 'r1'));
            expect(u.parentId).toBe('r1');
        });

        test('B5: nothing known → null', () => {
            const m = makeRow({
                externalId: 'm1',
                references: ['r1'],
                inReplyTo: 'r2',
            });
            const [u] = buildUpdates([m], ids('m1'));
            expect(u.parentId).toBe(null);
        });

        test('B6a: self-reference skipped, fallback to earlier ref', () => {
            const m = makeRow({
                externalId: 'm1',
                references: ['m1', 'r1'],
            });
            const [u] = buildUpdates([m], ids('m1', 'r1'));
            expect(u.parentId).toBe('r1');
        });

        test('B6b: self-reference only → null', () => {
            const m = makeRow({
                externalId: 'm1',
                references: ['m1'],
            });
            const [u] = buildUpdates([m], ids('m1'));
            expect(u.parentId).toBe(null);
        });
    });

    // ---- C. threadKey (DSU) ----
    describe('C. threadKey (DSU)', () => {
        test('C1: parent and child share threadKey', () => {
            const a = makeRow({ externalId: 'A' });
            const b = makeRow({ externalId: 'B', inReplyTo: 'A' });
            const byId = indexById(buildUpdates([a, b], ids('A', 'B')));
            expect(byId.get('A')!.threadKey).toBe('t-A');
            expect(byId.get('B')!.threadKey).toBe('t-A');
        });

        test('C2: chain A←B←C → all "t-A"', () => {
            const a = makeRow({ externalId: 'A' });
            const b = makeRow({ externalId: 'B', inReplyTo: 'A' });
            const c = makeRow({ externalId: 'C', inReplyTo: 'B' });
            const byId = indexById(buildUpdates([a, b, c], ids('A', 'B', 'C')));
            expect(byId.get('A')!.threadKey).toBe('t-A');
            expect(byId.get('B')!.threadKey).toBe('t-A');
            expect(byId.get('C')!.threadKey).toBe('t-A');
        });

        test('C3: unrelated messages → distinct threadKeys', () => {
            const a = makeRow({ externalId: 'A' });
            const b = makeRow({ externalId: 'B' });
            const byId = indexById(buildUpdates([a, b], ids('A', 'B')));
            expect(byId.get('A')!.threadKey).toBe('t-A');
            expect(byId.get('B')!.threadKey).toBe('t-B');
        });

        test('C4: common external root X (not in batch) → both "t-X"', () => {
            const a = makeRow({ externalId: 'A', inReplyTo: 'X' });
            const b = makeRow({ externalId: 'B', inReplyTo: 'X' });
            const byId = indexById(buildUpdates([a, b], ids('A', 'B')));
            expect(byId.get('A')!.threadKey).toBe('t-X');
            expect(byId.get('B')!.threadKey).toBe('t-X');
        });

        test('C5: dead reference becomes root', () => {
            const m = makeRow({ externalId: 'm1', references: ['dead'] });
            const [u] = buildUpdates([m], ids('m1'));
            expect(u.threadKey).toBe('t-dead');
        });

        test('C6: merge two isolated threads via third message', () => {
            const a = makeRow({ externalId: 'A' });
            const b = makeRow({ externalId: 'B' });
            const c = makeRow({
                externalId: 'C',
                references: ['A'],
                inReplyTo: 'B',
            });
            const result = buildUpdates([a, b, c], ids('A', 'B', 'C'));
            const keys = new Set(result.map((u) => u.threadKey));
            expect(keys.size).toBe(1);
        });

        test('C7: order independence (same component set)', () => {
            const a = makeRow({ externalId: 'A' });
            const b = makeRow({ externalId: 'B', inReplyTo: 'A' });
            const c = makeRow({ externalId: 'C', inReplyTo: 'B' });

            const set1 = new Set(
                buildUpdates([a, b, c], ids('A', 'B', 'C')).map((u) => u.threadKey),
            );
            const set2 = new Set(
                buildUpdates([c, b, a], ids('A', 'B', 'C')).map((u) => u.threadKey),
            );
            expect(set1).toEqual(set2);
        });
    });

    // ---- D. links collection ----
    describe('D. links collection', () => {
        test('D1: no references, no inReplyTo → no links', () => {
            const m = makeRow({ externalId: 'm1', references: [], inReplyTo: null });
            const [u] = buildUpdates([m], ids('m1'));
            expect(u.parentId).toBe(null);
            expect(u.threadKey).toBe('t-m1');
        });

        test('D2: only inReplyTo', () => {
            const m = makeRow({ externalId: 'm1', references: [], inReplyTo: 'X' });
            const [u] = buildUpdates([m], ids('m1', 'X'));
            expect(u.parentId).toBe('X');
            expect(u.threadKey).toBe('t-X');
        });

        test('D3: empty strings filtered from references and inReplyTo', () => {
            const m = makeRow({
                externalId: 'm1',
                references: ['', 'r1'],
                inReplyTo: '',
            });
            const [u] = buildUpdates([m], ids('m1', 'r1'));
            expect(u.parentId).toBe('r1');
        });
    });

    // ---- E. output shape ----
    describe('E. output shape', () => {
        test('E1: length matches input', () => {
            const rows = [
                makeRow({ externalId: 'A' }),
                makeRow({ externalId: 'B' }),
                makeRow({ externalId: 'C' }),
            ];
            expect(buildUpdates(rows, ids('A', 'B', 'C'))).toHaveLength(3);
        });

        test('E2: order preserved', () => {
            const a = makeRow({ externalId: 'A' });
            const b = makeRow({ externalId: 'B', inReplyTo: 'A' });
            const c = makeRow({ externalId: 'C' });
            const result = buildUpdates([c, a, b], ids('A', 'B', 'C'));
            expect(result.map((u) => u.externalId)).toEqual(['C', 'A', 'B']);
        });

        test('E3: each item has exactly {externalId, parentId, threadKey}', () => {
            const m = makeRow({ externalId: 'm1' });
            const [u] = buildUpdates([m], ids('m1'));
            expect(Object.keys(u).sort()).toEqual([
                'externalId',
                'parentId',
                'threadKey',
            ]);
        });
    });

    // ---- F. properties ----
    describe('F. properties', () => {
        test('F1: deterministic (two calls, same input)', () => {
            const rows = [
                makeRow({ externalId: 'A' }),
                makeRow({ externalId: 'B', inReplyTo: 'A' }),
            ];
            const r1 = buildUpdates(rows, ids('A', 'B'));
            const r2 = buildUpdates(rows, ids('A', 'B'));
            expect(r1).toEqual(r2);
        });

        test('F2: all messages of one DSU component share threadKey', () => {
            const a = makeRow({ externalId: 'A' });
            const b = makeRow({ externalId: 'B', inReplyTo: 'A' });
            const c = makeRow({ externalId: 'C', inReplyTo: 'B' });
            const result = buildUpdates([a, b, c], ids('A', 'B', 'C'));
            expect(new Set(result.map((u) => u.threadKey)).size).toBe(1);
        });

        test('F3: threadKey always starts with "t-" and is non-empty after prefix', () => {
            const rows = [
                makeRow({ externalId: 'a' }),
                makeRow({ externalId: 'b', inReplyTo: 'a' }),
                makeRow({ externalId: 'c', references: ['dead1', 'dead2'] }),
            ];
            const result = buildUpdates(rows, ids('a', 'b', 'c'));
            for (const u of result) {
                expect(u.threadKey).not.toBeNull();
                expect(u.threadKey!.startsWith('t-')).toBe(true);
                expect(u.threadKey!.length).toBeGreaterThan(2);
            }
        });
    });
});