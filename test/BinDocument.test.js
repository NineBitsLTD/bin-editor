import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BinDocument, bytesSeemBinary } from '../src/components/BinDocument.js';
import { PieceTable } from '../src/editor/PieceTable.js';

const SIZE = 300_000;
let dir, file, original;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-editor-test-'));
    file = path.join(dir, 'data.bin');
    original = Buffer.from(Uint8Array.from({ length: SIZE }, (_, i) => (i * 7) & 0xff));
    fs.writeFileSync(file, original);
    fs.chmodSync(file, 0o640);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const open = () => BinDocument.open({ fsPath: file }, file);
const leftovers = () => fs.readdirSync(dir).filter(n => n.includes('bin-editor-tmp'));

test('reads byte ranges with the file stamp and the free space', async () => {
    const doc = await open();
    const r = await doc.read(100_000, 65536, true);
    assert.equal(r.size, SIZE);
    assert.deepEqual(Buffer.from(r.data), original.subarray(100_000, 100_000 + 65536));
    assert.equal(typeof r.free, 'number');
    assert.ok(r.free > 0);
    const end = await doc.read(SIZE - 10, 65536);
    assert.equal(end.data.length, 10);
    assert.equal('free' in end, false);
});

test('patches in place: same size, only the new bytes change, the stamp follows', async () => {
    const doc = await open();
    const t = new PieceTable(SIZE);
    t.replace(5, 0xaa);
    t.replace(250_000, 0xbb);
    assert.equal(t.patchable, true);
    const stamp = await doc.writePatches(t.patches());
    const now = fs.readFileSync(file);
    assert.equal(now.length, SIZE);
    assert.equal(now[5], 0xaa);
    assert.equal(now[250_000], 0xbb);
    now[5] = original[5];
    now[250_000] = original[250_000];
    assert.deepEqual(now, original);
    assert.deepEqual(doc.stamp, stamp);
});

test('a patch outside the file is refused', async () => {
    const doc = await open();
    await assert.rejects(doc.writePatches([{ offset: SIZE, data: Uint8Array.of(1) }]));
});

test('rewrites the file from pieces (insert + delete), keeping its mode, no temporary file left', async () => {
    const doc = await open();
    const t = new PieceTable(SIZE);
    t.insert(0, 0x01);
    t.insert(1, 0x02);
    for (let i = 0; i < 1000; i++) t.delete(100);
    await doc.writeTo(t.pieces);
    const expected = Buffer.concat([Buffer.of(1, 2), original.subarray(0, 98), original.subarray(1098)]);
    assert.deepEqual(fs.readFileSync(file), expected);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.deepEqual(leftovers(), []);
    assert.equal(doc.stamp.size, expected.length);
});

test('Save As writes the edited file elsewhere and leaves the source alone', async () => {
    const doc = await open();
    const t = new PieceTable(SIZE);
    t.replace(0, 0xee);
    t.insert(SIZE, 0xff);
    const target = path.join(dir, 'copy.bin');
    const stampBefore = doc.stamp;
    await doc.writeTo(t.pieces, target);
    assert.deepEqual(fs.readFileSync(target), Buffer.concat([Buffer.of(0xee), original.subarray(1), Buffer.of(0xff)]));
    assert.deepEqual(fs.readFileSync(file), original);
    assert.deepEqual(doc.stamp, stampBefore);
});

test('a piece outside the file fails before writing anything', async () => {
    const doc = await open();
    await assert.rejects(doc.writeTo([{ d: SIZE - 5, n: 10 }]));
    assert.deepEqual(fs.readFileSync(file), original);
    assert.deepEqual(leftovers(), []);
});

test('backups keep the pieces with their new bytes', async () => {
    const doc = await open();
    const t = new PieceTable(SIZE);
    t.replace(10, 0x42);
    t.insert(20, 0x43);
    const backup = path.join(dir, 'backups', 'one.json');
    await BinDocument.writeBackup(backup, { ...doc.stamp, pieces: t.pieces });
    const back = await BinDocument.readBackup(backup);
    assert.deepEqual({ size: back.size, mtime: back.mtime }, doc.stamp);
    const restored = new PieceTable(back.size, back.pieces);
    assert.deepEqual(restored.read(0, 30, o => original[o]).vals, t.read(0, 30, o => original[o]).vals);
});

test('stampOf refuses a folder', async () => {
    await assert.rejects(BinDocument.stampOf(dir));
});

test('tells binary files as VS Code does: a zero byte in the first 512 bytes, unless UTF-16', () => {
    const bytes = (...b) => Uint8Array.from(b);
    assert.equal(bytesSeemBinary(new Uint8Array(0)), false);
    assert.equal(bytesSeemBinary(Buffer.from('plain text\n')), false);
    assert.equal(bytesSeemBinary(bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00)), true);
    assert.equal(bytesSeemBinary(Buffer.from('\ufeffutf-8 with a BOM\0')), true);
    // UTF-16 by the byte order mark, or by zero bytes at every odd (LE) / even (BE) offset
    assert.equal(bytesSeemBinary(bytes(0xff, 0xfe, 0x00, 0x00, 0x01, 0x02)), false);
    assert.equal(bytesSeemBinary(bytes(0xfe, 0xff, 0x00, 0x00)), false);
    assert.equal(bytesSeemBinary(Buffer.from('text', 'utf16le')), false);
    assert.equal(bytesSeemBinary(Buffer.from('text', 'utf16le').swap16()), false);
    assert.equal(bytesSeemBinary(bytes(0x41, 0x00, 0x42, 0x43)), true);
    // only the first 512 bytes count
    const late = Buffer.alloc(1000, 0x41);
    late[600] = 0;
    assert.equal(bytesSeemBinary(late), false);
    late[511] = 0;
    assert.equal(bytesSeemBinary(late), true);
});

test('seemsBinary reads the start of the file', async () => {
    assert.equal(await BinDocument.seemsBinary(file), true);
    const text = path.join(dir, 'notes.txt');
    fs.writeFileSync(text, 'text\n'.repeat(1000));
    assert.equal(await BinDocument.seemsBinary(text), false);
    await assert.rejects(BinDocument.seemsBinary(path.join(dir, 'missing')));
});
