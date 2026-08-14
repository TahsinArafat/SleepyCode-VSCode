import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function requiresApproval(kind, mode, destructive) {
  if (mode === 'autonomous') return false;
  if (mode === 'edits') return kind === 'command';
  return true;
}

describe('requiresApproval', () => {
  it('autonomous never approves', () => {
    assert.equal(requiresApproval('edit', 'autonomous', false), false);
    assert.equal(requiresApproval('command', 'autonomous', false), false);
    assert.equal(requiresApproval('command', 'autonomous', true), false);
  });

  it('ask always approves', () => {
    assert.equal(requiresApproval('edit', 'ask', false), true);
    assert.equal(requiresApproval('command', 'ask', false), true);
    assert.equal(requiresApproval('command', 'ask', true), true);
  });

  it('edits approves commands but not edits', () => {
    assert.equal(requiresApproval('edit', 'edits', false), false);
    assert.equal(requiresApproval('command', 'edits', false), true);
    assert.equal(requiresApproval('command', 'edits', true), true);
  });
});
