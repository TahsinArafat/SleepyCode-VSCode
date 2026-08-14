import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/,
  /\brmdir\b/,
  /\brmtree\b/,
  /\b(?:del|erase|deltree)\b/,
  /\bremove-item\b/,
  /\brd\b\s+[/-]\w*[sqr]\b/,
  /\b(?:unlink|os\.remove|os\.unlink|shutil\.rmtree|pathlib\.\w+\.unlink)\b/,
  /\bclear-(?:content|item|recyclebin)\b/,
  /\breg\s+delete\b/,
  /\bgit\s+(?:rm\b|clean|checkout\s+--(?!track\b|orphan\b|detach\b)|checkout\s+\.|restore\s+(?!--staged\b)|reset\s+--hard|branch\s+-(?:[dD]\b|--?delete\b)|tag\s+-d|stash\s+(?:drop|clear)|remote\s+(?:rm|remove)|filter-branch|reflog\s+expire|update-ref\s+-d)/,
  /\bgit\s+push\b[^|;&]*\s--?f(?:orce)?\b/,
  /\bmkfs(?:\.\w+)?\b/,
  /\b(?:fdisk|parted|dd|shred|wipefs|diskpart|format-volume|clear-disk)\b/,
  /\bformat\s+[a-z]:/,
  /\b(?:kill|pkill|killall|taskkill|stop-process|stop-service|stop-computer)\b/,
  /drop\s+(?:table|database|view|index|trigger|schema|user|role|sequence)/,
  /\btruncate\b/,
  /\s>\s*(?!\/dev\/null\b|&\d)\S+/,
  /\b(?:docker|podman)\s+(?:rm|rmi|volume\s+rm|image\s+prune|builder\s+prune|network\s+prune|system\s+prune)\b/,
  /\bkubectl\s+delete\b/,
  /\bterraform\s+(?:destroy|apply\s+-destroy)\b/,
  /\b(?:pip|pip3|pipx)\s+uninstall\b/,
  /\bnpm\s+uninstall\b/,
  /\b(?:yarn|pnpm)\s+remove\b/,
  /\b(?:apt|apt-get|yum|dnf|brew|cargo)\s+(?:remove|purge|autoremove|uninstall)\b/,
  /\bmvn\s+(?:clean|dependency:purge-local-repository)\b/,
];

function isDestructiveCommand(command) {
  const text = command.trim().toLowerCase();
  if (!text) return false;
  return DESTRUCTIVE_PATTERNS.some(pattern => pattern.test(text));
}

function isSecret(filePath) {
  return filePath.split(/[\\/]/).some(part => /^\.env(?:\.|$)/i.test(part) || /^(credentials|secrets?)\.(json|ya?ml|toml)$/i.test(part));
}

function normalizeApprovalMode(value) {
  return value === 'edits' || value === 'autonomous' ? value : 'ask';
}

describe('isSecret', () => {
  it('blocks .env files', () => {
    assert.equal(isSecret('.env'), true);
    assert.equal(isSecret('path/to/.env'), true);
  });

  it('blocks credential files', () => {
    assert.equal(isSecret('credentials.json'), true);
    assert.equal(isSecret('secrets.yaml'), true);
  });

  it('allows normal files', () => {
    assert.equal(isSecret('package.json'), false);
    assert.equal(isSecret('src/index.ts'), false);
  });
});

describe('normalizeApprovalMode', () => {
  it('normalizes valid modes', () => {
    assert.equal(normalizeApprovalMode('ask'), 'ask');
    assert.equal(normalizeApprovalMode('edits'), 'edits');
    assert.equal(normalizeApprovalMode('autonomous'), 'autonomous');
  });

  it('defaults invalid modes to ask', () => {
    assert.equal(normalizeApprovalMode('invalid'), 'ask');
    assert.equal(normalizeApprovalMode(''), 'ask');
  });
});

describe('isDestructiveCommand', () => {
  it('detects rm commands', () => {
    assert.equal(isDestructiveCommand('rm -rf /'), true);
  });

  it('detects git destructive commands', () => {
    assert.equal(isDestructiveCommand('git reset --hard'), true);
    assert.equal(isDestructiveCommand('git push --force'), true);
  });

  it('allows safe commands', () => {
    assert.equal(isDestructiveCommand('npm install'), false);
    assert.equal(isDestructiveCommand('echo hello'), false);
  });
});
