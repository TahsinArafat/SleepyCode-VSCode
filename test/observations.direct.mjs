import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  capObservation,
  archiveObservation,
  readObservationPage,
  OBSERVATION_THRESHOLD_BYTES,
} from '../src/observations.ts';

test('capObservation leaves small payloads untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  try {
    const result = await capObservation(dir, 'read_file', 'hello world');
    assert.equal(result.text, 'hello world');
    assert.equal(result.observation, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('capObservation archives large payloads and keeps them recallable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  try {
    const full = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    assert.ok(Buffer.byteLength(full) > OBSERVATION_THRESHOLD_BYTES);

    const capped = await capObservation(dir, 'read_file', full);
    assert.ok(capped.observation, 'a handle should be produced');
    assert.match(capped.text, /\[archived observation obs_[a-f0-9]{24}/);
    // The inline text must be smaller than the original — that is the whole point.
    assert.ok(capped.text.length < full.length);
    // The full bytes are recoverable, so nothing was destroyed.
    const page = await readObservationPage(dir, capped.observation.id, 0);
    assert.ok(page.text.includes('line 0'));
    assert.equal(page.totalBytes, Buffer.byteLength(full));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('archiving is idempotent for identical content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  try {
    const text = 'x'.repeat(OBSERVATION_THRESHOLD_BYTES + 10);
    const a = await archiveObservation(dir, 'read_file', text);
    const b = await archiveObservation(dir, 'read_file', text);
    assert.equal(a.id, b.id);
    assert.equal(a.bytes, b.bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readObservationPage pages through the archive without loss', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  try {
    const full = Array.from({ length: 20000 }, (_, i) => `line ${i} padded ${'y'.repeat(20)}`).join('\n');
    const handle = await archiveObservation(dir, 'read_file', full);
    let offset = 0;
    let assembled = '';
    let pages = 0;
    while (offset !== null && pages < 100) {
      const page = await readObservationPage(dir, handle.id, offset);
      assembled += page.text;
      offset = page.nextOffset;
      pages++;
    }
    assert.ok(pages > 1, 'large content should take multiple pages');
    assert.equal(assembled, full, 'paging must reconstruct the original byte-for-byte');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readObservationPage rejects malformed ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'obs-'));
  try {
    await assert.rejects(() => readObservationPage(dir, '../../etc/passwd'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
