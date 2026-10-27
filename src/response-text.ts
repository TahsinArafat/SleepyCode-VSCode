/*
 * The answer text of one response, for the message actions (Copy).
 *
 * Building it walks every block, and the transcript asks for it on every
 * streamed frame — a reply with hundreds of blocks would rebuild the same string
 * once per delta. Settled turns keep their blocks array, so the joined text is
 * remembered against that array.
 *
 * Sound because the reducer publishes a NEW blocks array whenever the answer
 * changes; `test/turns-blocks-identity.direct.mjs` holds that end of the bargain.
 * The block shape is structural so this stays free of webview imports.
 */

export interface ResponseBlock {
  kind: string;
  text?: string;
  message?: string;
}

const joined = new WeakMap<readonly ResponseBlock[], string>();

export function responseText(blocks: readonly ResponseBlock[]): string {
  let text = joined.get(blocks);
  if (text === undefined) {
    text = blocks.flatMap((block) => block.kind === 'text' ? [block.text ?? ''] : block.kind === 'error' ? [block.message ?? ''] : []).join('\n\n');
    joined.set(blocks, text);
  }
  return text;
}