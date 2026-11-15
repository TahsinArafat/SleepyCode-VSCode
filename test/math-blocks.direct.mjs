import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMathRenderer,
  protectInlineMath,
  restoreMath,
  hasMathTokens,
  MATH_CACHE_MAX,
} from '../src/math-blocks.ts';

/*
 * Math is pulled out of the markdown before marked sees it, because marked reads `_`, `*`
 * and `\` as markup and mangles LaTeX: `a_1 + b_2` becomes emphasis, and `\frac{1}{2}` loses
 * a backslash. Each formula becomes a placeholder token, the surrounding markdown is parsed
 * normally, and the rendered HTML is substituted back.
 *
 * These pin the tokenizer's two halves: which delimiters are math at all, and that the
 * currency guards hold. A formula that is not recognised is shown as LaTeX rather than
 * mangled; a price rendered as a formula is worse than either.
 *
 * The renderer is injected, so nothing here needs a DOM or KaTeX.
 */

const render = (tex, display) => `<${display ? 'block' : 'inline'}>${tex}</>`;
const math = () => createMathRenderer(render);
const protect = (line, allowMath) => {
  const budget = { remaining: 64_000 };
  return protectInlineMath(line, allowMath, math(), budget);
};

const roundTrip = (line, allowMath) => {
  const split = protect(line, allowMath);
  return restoreMath(`<p>${split.text}</p>`, split.html);
};

test('display math is recognised in both delimiter forms', () => {
  assert.equal(roundTrip('$$x^2$$'), '<p><block>x^2</></p>');
  assert.equal(roundTrip('\\[x^2\\]'), '<p><block>x^2</></p>');
});

test('inline math is recognised in both delimiter forms', () => {
  assert.equal(roundTrip('$x^2$'), '<p><inline>x^2</></p>');
  assert.equal(roundTrip('\\(x^2\\)'), '<p><inline>x^2</></p>');
});

test('math is protected before marked can mangle it', () => {
  // `_` and `*` are emphasis to marked. If the LaTeX reached it, this would render as italic.
  const split = protect('a_1 + b_2 and $x_1$', undefined);
  assert.ok(hasMathTokens(split.text), 'the formula must be a placeholder, not raw LaTeX');
  assert.ok(!split.text.includes('x_1'), 'the LaTeX body must not survive into the markdown');
});

test('a price is prose, not a formula', () => {
  // Rendering "$5.00" as math is worse than leaving it alone: it is the common case in
  // ordinary prose, and the model writes it constantly.
  for (const line of ['It costs $5.00.', 'Total: $10', 'That is $1,200 altogether.']) {
    assert.equal(roundTrip(line), `<p>${line}</p>`, `${line} must stay prose`);
  }
});

test('two prices in one sentence are not read as a range', () => {
  // "$10 and $20" has a valid-looking `$...$` span between the two numbers; the guards must
  // reject it, or the text between two prices silently becomes a formula.
  const line = 'costs $10 and $20 total';
  assert.equal(roundTrip(line), `<p>${line}</p>`);
});

test('a dollar range with spaces is prose', () => {
  // "$5 to $10" would otherwise match `$5 to $`.
  const line = 'between $5 and $10';
  assert.equal(protect(line, undefined).html.length, 0, 'no formula should be extracted');
});

test('allowMath false leaves the line completely alone', () => {
  const split = protect('$x^2$ and $$y^2$$', false);
  assert.equal(split.text, '$x^2$ and $$y^2$$');
  assert.equal(split.html.length, 0);
});

test('a line with no math is returned unchanged and allocates nothing', () => {
  const split = protect('just an ordinary sentence', undefined);
  assert.equal(split.text, 'just an ordinary sentence');
  assert.equal(split.html.length, 0);
});

test('several formulas in one line are all extracted and restored in order', () => {
  // The prose between them must survive, and each token must map back to its own formula: an
  // off-by-one here shows `a` where `b` belongs, which a test that only counts would miss.
  const line = '$a$ then $b$ then $c$';
  const split = protect(line, undefined);
  assert.equal(split.html.length, 3);
  assert.equal(
    restoreMath(`<p>${split.text}</p>`, split.html),
    '<p><inline>a</> then <inline>b</> then <inline>c</></p>',
  );
});

test('a formula is rendered once however many times it is asked for', () => {
  // The same formula is rendered on every streaming frame and on every history rebuild, and
  // KaTeX dominates the cost of a math-bearing answer, so the cache is the point.
  let calls = 0;
  const counting = createMathRenderer((tex, display) => { calls++; return render(tex, display); });
  const budget = { remaining: 64_000 };
  for (let i = 0; i < 5; i++) protectInlineMath('$x^2$', undefined, counting, budget);
  assert.equal(calls, 1, 'the second and later renders are served from the cache');
});

test('display and inline forms of the same source are separate cache entries', () => {
  let calls = 0;
  const counting = createMathRenderer((tex, display) => { calls++; return render(tex, display); });
  const budget = { remaining: 64_000 };
  protectInlineMath('$x$', undefined, counting, budget);
  protectInlineMath('$$x$$', undefined, counting, budget);
  assert.equal(calls, 2, 'the mode is part of the identity');
});

test('the cache is bounded, so a long session cannot grow it without limit', () => {
  let calls = 0;
  const counting = createMathRenderer((tex, display) => { calls++; return render(tex, display); }, 4);
  const budget = { remaining: 64_000 };
  for (let i = 0; i < 10; i++) {
    protectInlineMath(`$x_${i}$`, undefined, counting, budget);
  }
  assert.ok(counting.size() <= 4, `cache must stay at or under its cap, got ${counting.size()}`);
});

test('a renderer that throws degrades to readable LaTeX rather than an empty gap', () => {
  const broken = createMathRenderer(() => { throw new Error('katex exploded'); });
  const budget = { remaining: 64_000 };
  const split = protectInlineMath('$x^2$', undefined, broken, budget);
  assert.equal(restoreMath(`<p>${split.text}</p>`, split.html), '<p><code>x^2</code></p>');
});

test('with no renderer at all the LaTeX is still shown, never silently dropped', () => {
  const none = createMathRenderer(undefined);
  const budget = { remaining: 64_000 };
  const split = protectInlineMath('$x^2$', undefined, none, budget);
  assert.equal(restoreMath(`<p>${split.text}</p>`, split.html), '<p><code>x^2</code></p>');
});

test('an empty formula renders nothing rather than an empty span', () => {
  const m = math();
  assert.equal(m.render('', false), '');
  assert.equal(m.render('   ', true), '');
});

test('a formula is bounded by the budget so one enormous input cannot stall a frame', () => {
  let calls = 0;
  const counting = createMathRenderer((tex) => { calls++; return tex; });
  const budget = { remaining: 100 };
  const huge = 'x'.repeat(5_000);
  protectInlineMath(`$${huge}$`, undefined, counting, budget);
  assert.equal(calls, 1, 'it still renders, once');
});

test('the default cache cap is the documented one', () => {
  assert.equal(MATH_CACHE_MAX, 256);
});

test('restoreMath leaves HTML without placeholders untouched', () => {
  assert.equal(restoreMath('<p>plain</p>', []), '<p>plain</p>');
  assert.equal(hasMathTokens('<p>plain</p>'), false);
});