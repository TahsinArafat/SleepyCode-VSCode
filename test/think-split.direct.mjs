import test from 'node:test';
import assert from 'node:assert/strict';
import { createThinkSplitter, stripThinkBlocks } from '../src/think-strip.ts';

// Tag literals are built by concatenation so the source never contains a raw
// `<think>` sequence (the tool pipeline strips those from generated content).
const T = '<' + 'think' + '>';
const TC = '<' + '/' + 'think' + '>';
const TG = '<' + 'thinking' + '>';
const TGC = '<' + '/' + 'thinking' + '>';

test('stripThinkBlocks removes complete blocks', () => {
  const raw = `${T} User asked what is here ${TC} Let me look around.`;
  assert.equal(stripThinkBlocks(raw).trim(), 'Let me look around.');
});

test('stripThinkBlocks handles both tag spellings and multiple blocks', () => {
  const raw = `${TG}one${TGC} A ${T}two${TC} B`;
  assert.equal(stripThinkBlocks(raw), ' A  B');
});

test('stripThinkBlocks is case-insensitive and attribute-tolerant', () => {
  assert.equal(stripThinkBlocks(`${T.toUpperCase()} markdown="1"hidden${TC.toUpperCase()}shown`), 'shown');
});

test('splitter routes content and thinking from a single chunk', () => {
  const split = createThinkSplitter();
  const { content, thinking } = split(`${T} why ${TC} The answer.`);
  assert.equal(content, ' The answer.');
  assert.equal(thinking, ' why ');
});

test('splitter carries an open block across chunks', () => {
  const split = createThinkSplitter();
  const first = split(`${T} start of `);
  const second = split('reasoning ');
  const third = split(`${TC} visible!`);
  assert.equal(first.content + second.content + third.content, ' visible!');
  assert.equal(first.thinking + second.thinking + third.thinking, ' start of reasoning ');
});

test('splitter keeps text before an unclosed open and buffers the rest', () => {
  const split = createThinkSplitter();
  const first = split(`before${T}inside`);
  assert.equal(first.content, 'before');
  assert.equal(first.thinking, 'inside');
  const second = split(`more${TC}after`);
  assert.equal(second.content, 'after');
  assert.equal(second.thinking, 'more');
});

test('splitter leaves plain text untouched', () => {
  const split = createThinkSplitter();
  const { content, thinking } = split('Just a normal sentence with no XML tags.');
  assert.equal(thinking, '');
  assert.equal(content, 'Just a normal sentence with no XML tags.');
});

test('splitter handles multiple blocks in one chunk with text between', () => {
  const split = createThinkSplitter();
  const { content, thinking } = split(`A${T}1${TC}B${T}2${TC}C`);
  assert.equal(content, 'ABC');
  assert.equal(thinking, '12');
});

test('splitter handles multiple blocks across chunks', () => {
  const split = createThinkSplitter();
  // block 1 opens+closes inside chunk 1; block 2 spans chunks 2-3.
  const c1 = split(`${T}one${TC}A${T}two`);
  const c2 = split(`three${TC}B${T}four`);
  const c3 = split(`${TC}C`);
  assert.equal(c1.content + c2.content + c3.content, 'ABC');
  assert.equal(c1.thinking + c2.thinking + c3.thinking, 'onetwothreefour');
});

test('stripThinkBlocks removes every block, not just the first', () => {
  assert.equal(stripThinkBlocks(`A${T}1${TC}B${T}2${TC}C`).trim(), 'ABC');
});
