import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PieceTable } from '../src/editor/PieceTable.js';

const disk = Uint8Array.from({ length: 10 }, (_, i) => i);
const diskByte = o => disk[o];
const bytes = t => t.read(0, t.len, diskByte).vals;

test('a fresh table is the file as it is', () => {
    const t = new PieceTable(10);
    assert.equal(t.len, 10);
    assert.equal(t.dirty, false);
    assert.equal(t.patchable, true);
    assert.deepEqual(bytes(t), [...disk]);
});

test('overwriting keeps offsets: patchable, with patches at their offsets', () => {
    const t = new PieceTable(10);
    t.replace(3, 0xaa);
    t.replace(4, 0xbb);
    assert.equal(t.dirty, true);
    assert.equal(t.patchable, true);
    assert.deepEqual(t.patches().map(p => [p.offset, [...p.data]]), [[3, [0xaa, 0xbb]]]);
    const { vals, mods } = t.read(2, 4, diskByte);
    assert.deepEqual(vals, [2, 0xaa, 0xbb, 5]);
    assert.deepEqual(mods, [false, true, true, false]);
    assert.deepEqual(t.changes(), { added: 2, delta: 0 });
});

test('inserting and deleting move bytes: not patchable', () => {
    const t = new PieceTable(10);
    t.insert(0, 0xff);
    assert.equal(t.len, 11);
    assert.equal(t.patchable, false);
    assert.deepEqual(bytes(t), [0xff, ...disk]);
    t.delete(5);
    t.delete(5);
    assert.deepEqual(bytes(t), [0xff, 0, 1, 2, 3, 6, 7, 8, 9]);
    assert.deepEqual(t.changes(), { added: 1, delta: -1 });
});

test('deleting what was inserted gives the file back (clean again)', () => {
    const t = new PieceTable(10);
    t.insert(4, 0x11);
    t.delete(4);
    assert.equal(t.dirty, false);
    assert.equal(t.pieces.length, 1);
});

test('snapshots are not changed by later edits (undo)', () => {
    const t = new PieceTable(10);
    t.replace(1, 0x55);
    const before = t.pieces;
    t.insert(1, 0x66);
    t.set(before);
    assert.deepEqual(bytes(t), [0, 0x55, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('an empty file: appending makes it dirty', () => {
    const t = new PieceTable(0);
    assert.equal(t.dirty, false);
    t.insert(0, 0x41);
    t.insert(1, 0x42);
    assert.equal(t.dirty, true);
    assert.deepEqual(t.read(0, 2, () => undefined).vals, [0x41, 0x42]);
});

test('unloaded disk bytes read as undefined', () => {
    const t = new PieceTable(10);
    t.replace(0, 7);
    assert.deepEqual(t.read(0, 3, () => undefined).vals, [7, undefined, undefined]);
});
