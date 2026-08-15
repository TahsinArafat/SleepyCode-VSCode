import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import type { Provider } from './providers';
import { MAX_TOOL_OUTPUT } from './types';
import type { TranscriptItem, WorkItem, ApprovalMode, AgentErrorPresentation } from './types';

export function pathInside(root: string, candidate: string): boolean {
  const lexical = path.relative(root, candidate);
  if (lexical === '' || lexical === '..' || lexical.startsWith('..' + path.sep) || path.isAbsolute(lexical)) return false;
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    const resolved = path.relative(realRoot, realCandidate);
    return resolved !== '' && resolved !== '..' && !resolved.startsWith('..' + path.sep) && !path.isAbsolute(resolved);
  } catch {
    // Non-existent candidates are validated lexically here and checked again by resolvePathSafe before file access.
    return true;
  }
}

export function resolvePathSafe(root: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error('Path must stay inside the workspace.');
  }

  const realRoot = realpathSync(root);
  const candidate = path.join(realRoot, normalized);
  let checkPath = candidate;

  while (true) {
    try {
      const real = realpathSync(checkPath);
      if (real === realRoot || real.startsWith(realRoot + path.sep)) return candidate;
      throw new Error('Path escapes the workspace.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(checkPath);
      if (parent === checkPath) throw new Error('Path escapes the workspace.');
      checkPath = parent;
    }
  }
}

export function createTranscriptItem(role: 'user' | 'assistant', text: string, kind?: 'error' | 'divider', gitTree?: string, work?: WorkItem[], seconds?: number, inputTokens?: number, outputTokens?: number): TranscriptItem {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role, text, timestamp: Date.now(), kind, gitTree, work, seconds, inputTokens, outputTokens };
}

export function normalizeTranscriptItem(item: Partial<TranscriptItem>, fallbackTimestamp: number): TranscriptItem {
  return {
    id: item.id ?? `${fallbackTimestamp}-${Math.random().toString(36).slice(2, 8)}`,
    role: item.role === 'assistant' ? 'assistant' : 'user',
    text: item.text ?? '',
    timestamp: item.timestamp ?? fallbackTimestamp,
    kind: item.kind,
    gitTree: item.gitTree,
    work: item.work,
    seconds: item.seconds,
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    contextTokens: item.contextTokens,
    attachments: item.attachments,
    changes: item.changes,
    errorInfo: item.errorInfo,
    commitHash: item.commitHash,
    commitMessage: item.commitMessage,
    paused: item.paused,
    pauseReason: item.pauseReason,
    pauseLimit: item.pauseLimit,
  };
}

export function shouldAutoContinue(answer: string, finishReason: string, continuationCount: number): boolean {
  if (continuationCount >= 2) return false;
  if (finishReason === 'length') return true;
  if (finishReason && finishReason !== 'stop' && finishReason !== 'unknown' && finishReason !== 'other') return false;
  const text = answer.trim();
  if (!text) return true;
  const tail = text.slice(-700);
  const unfinishedAction = /(?:^|\n)(?:now|next|then|after that)\b[^\n]{0,500}(?::|\.{3}|…)$/i;
  const statedIntent = /(?:^|\n)(?:let me|i(?:'ll| will| am going to| need to))\s+(?:update|edit|change|fix|add|remove|create|write|implement|run|inspect|check|test|open|read|wire|finish|build)\b[^\n]{0,400}(?::|\.{3}|…)?$/i;
  return unfinishedAction.test(tail) || statedIntent.test(tail);
}

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

export function isDestructiveCommand(command: string): boolean {
  const text = command.trim().toLowerCase();
  if (!text) return false;
  return DESTRUCTIVE_PATTERNS.some(pattern => pattern.test(text));
}

export function isSecret(filePath: string): boolean {
  return filePath.split(/[\\/]/).some(part => /^\.env(?:\.|$)/i.test(part) || /^(credentials|secrets?)\.(json|ya?ml|toml)$/i.test(part));
}

export function assertNotSecret(filePath: string): void {
  if (isSecret(filePath)) throw new Error('Access to environment and credential files is blocked.');
}

export function truncate(value: string): string {
  return value.length > MAX_TOOL_OUTPUT ? `${value.slice(0, MAX_TOOL_OUTPUT)}\n…(truncated)` : value;
}

export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  return String(record.path ?? record.query ?? record.glob ?? record.command ?? record.source ?? record.skill ?? record.skills ?? '').slice(0, 100);
}

export function humanToolName(name: string): string {
  return ({ list_files: 'Listing files', read_file: 'Reading file', search_files: 'Searching workspace', write_file: 'Writing file', replace_text: 'Editing file', delete_file: 'Deleting file', get_diagnostics: 'Checking diagnostics', run_command: 'Running command', web_search: 'Searching the web', plan: 'Planning', delegate_task: 'Running subagent', terminal_start: 'Starting terminal', terminal_write: 'Writing to terminal', terminal_read: 'Reading terminal', terminal_list: 'Listing terminals', terminal_stop: 'Stopping terminal', memory_read: 'Reading project memory', memory_update: 'Updating project memory', skillsmp_search: 'Searching SkillsMP', skillsmp_list_repo_skills: 'Listing repo skills', skillsmp_get_skill: 'Previewing skill', skillsmp_install_skill: 'Installing skill', skillsmp_list_installed: 'Listing installed skills', skillsmp_read_installed: 'Reading installed skill' } as Record<string, string>)[name] ?? name;
}

export function toolTask(name: string, input: unknown): string {
  const detail = summarizeInput(input);
  return detail ? `${humanToolName(name)} · ${detail}` : humanToolName(name);
}

export function conversationTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 46 ? `${clean.slice(0, 45)}…` : clean || 'New conversation';
}

export function normalizeApprovalMode(value: string): 'ask' | 'edits' | 'autonomous' {
  return value === 'edits' || value === 'autonomous' ? value : 'ask';
}

export function requiresApproval(kind: 'edit' | 'command', mode: ApprovalMode, _destructive: boolean): boolean {
  if (mode === 'autonomous') return false;
  if (mode === 'edits') return kind === 'command';
  return true;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function providerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (record.error && typeof record.error === 'object') {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === 'string') return nested.message;
    }
    if (typeof record.responseBody === 'string') {
      try {
        const body = JSON.parse(record.responseBody) as { error?: { message?: string } | string; message?: string };
        if (typeof body.error === 'string') return body.error;
        if (body.error && typeof body.error.message === 'string') return body.error.message;
        if (typeof body.message === 'string') return body.message;
      } catch { }
    }
  }
  return errorMessage(error);
}

export function friendlyError(error: unknown, provider?: Provider): string {
  const message = providerErrorMessage(error);
  const name = provider?.name ?? 'the provider';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|networkerror/i.test(message)) {
    const isLocal = /localhost|127\.0\.0\.1/.test(provider?.baseURL ?? '');
    return isLocal
      ? `Could not connect to ${name}. Make sure its local server is running, then try again.`
      : `Could not connect to ${name}. Check your internet connection and try again.`;
  }
  if (/api[ _-]?key/i.test(message) && /invalid|not valid|valid api key|unauthorized|rejected|please pass|400|401|403/i.test(message)) {
    return `${name} rejected the API key. Check the key in Settings.`;
  }
  return message;
}


function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  for (const value of [record.statusCode, record.status, (record.response as Record<string, unknown> | undefined)?.status, (record.cause as Record<string, unknown> | undefined)?.statusCode]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function classifyAgentError(error: unknown, provider?: Provider): AgentErrorPresentation {
  const raw = providerErrorMessage(error);
  const status = statusCodeOf(error);
  const sleepy = Boolean(provider?.isSleepy);
  const providerName = provider?.name ?? 'AI provider';
  const lower = raw.toLowerCase();

  if (/user (?:denied|rejected)|action (?:was )?denied|not approved/.test(lower)) {
    return {
      code: 'action_denied',
      title: 'Action was not approved',
      message: 'The task stopped because a requested edit or command was not approved.',
      retryable: true,
      primaryAction: 'retry',
      primaryLabel: 'Retry task',
    };
  }

  if (
    status === 401
    || status === 403
    || /\bunauthori[sz]ed\b|\bforbidden\b|session expired|token expired|invalid token|authentication required/.test(lower)
  ) {
    return sleepy
      ? {
        code: 'auth_required',
        title: 'SleepyAI session expired',
        message: 'Your SleepyAI session is no longer valid. Sign in again to continue.',
        retryable: false,
        primaryAction: 'signin',
        primaryLabel: 'Sign in again',
        secondaryAction: 'account',
        secondaryLabel: 'Open account',
      }
      : {
        code: 'auth_required',
        title: `${providerName} authentication failed`,
        message: friendlyError(error, provider),
        retryable: false,
        primaryAction: 'settings',
        primaryLabel: 'Open settings',
      };
  }

  if (
    /context (?:length|window)|maximum context|too many tokens|prompt is too long|context_length_exceeded/.test(lower)
  ) {
    return {
      code: 'context_too_large',
      title: 'Context is too large',
      message: 'This request exceeds the selected model’s context window. Remove some context or choose a model with a larger context window.',
      retryable: false,
      primaryAction: 'context',
      primaryLabel: 'Manage context',
      secondaryAction: 'models',
      secondaryLabel: 'Choose model',
    };
  }

  if (
    status === 402
    || /insufficient (?:credit|balance)|credits? (?:exhausted|depleted)|payment required|no remaining credits/.test(lower)
  ) {
    return sleepy
      ? {
        code: 'credits_exhausted',
        title: 'SleepyAI credits unavailable',
        message: 'Your SleepyAI account does not currently have enough available credit for this request.',
        retryable: false,
        primaryAction: 'account',
        primaryLabel: 'Manage plan',
      }
      : {
        code: 'provider_error',
        title: `${providerName} billing issue`,
        message: friendlyError(error, provider),
        retryable: false,
        primaryAction: 'settings',
        primaryLabel: 'Open settings',
      };
  }

  if (
    /(?:monthly|daily|weekly|5h|usage|spend|quota|request)[^\n]{0,50}(?:limit|allowance)[^\n]{0,30}(?:reached|exceeded|used)|(?:limit|quota)[^\n]{0,30}(?:reached|exceeded)/.test(lower)
  ) {
    return sleepy
      ? {
        code: 'account_limit',
        title: 'SleepyAI usage limit reached',
        message: 'This request is blocked by your current SleepyAI usage allowance or spending limit.',
        retryable: false,
        primaryAction: 'account',
        primaryLabel: 'View usage & plan',
      }
      : {
        code: 'provider_error',
        title: `${providerName} usage limit reached`,
        message: friendlyError(error, provider),
        retryable: false,
        primaryAction: 'settings',
        primaryLabel: 'Open settings',
      };
  }

  if (status === 429 || /\brate limit\b|too many requests|\bratelimit\b/.test(lower)) {
    return {
      code: 'rate_limited',
      title: sleepy ? 'SleepyAI is rate limiting requests' : `${providerName} is rate limiting requests`,
      message: 'Too many requests were sent in a short period. Retry after a short delay.',
      retryable: true,
      primaryAction: 'retry',
      primaryLabel: 'Retry',
      ...(sleepy ? { secondaryAction: 'account' as const, secondaryLabel: 'View usage' } : {}),
    };
  }

  if (
    status === 404
    || /model[^\n]{0,45}(?:not found|unavailable|does not exist|unsupported)|unknown model/.test(lower)
  ) {
    return {
      code: 'model_unavailable',
      title: 'Selected model is unavailable',
      message: sleepy
        ? 'The selected SleepyAI model is unavailable for this account or request. Choose another model and retry.'
        : friendlyError(error, provider),
      retryable: false,
      primaryAction: 'models',
      primaryLabel: 'Choose model',
    };
  }

  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|networkerror|network error|socket hang up/i.test(raw)) {
    return {
      code: 'network',
      title: sleepy ? 'Cannot reach SleepyAI' : `Cannot reach ${providerName}`,
      message: friendlyError(error, provider),
      retryable: true,
      primaryAction: 'retry',
      primaryLabel: 'Retry',
    };
  }

  if ((status !== undefined && status >= 500) || /service unavailable|bad gateway|gateway timeout|internal server error/.test(lower)) {
    return {
      code: 'service_unavailable',
      title: sleepy ? 'SleepyAI is temporarily unavailable' : `${providerName} is temporarily unavailable`,
      message: 'The service returned a temporary server error. Retry in a moment.',
      retryable: true,
      primaryAction: 'retry',
      primaryLabel: 'Retry',
    };
  }

  return {
    code: provider ? 'provider_error' : 'unknown',
    title: sleepy ? 'SleepyAI request failed' : `${providerName} request failed`,
    message: friendlyError(error, provider),
    retryable: true,
    primaryAction: 'retry',
    primaryLabel: 'Retry',
    ...(sleepy ? { secondaryAction: 'account' as const, secondaryLabel: 'SleepyAI account' } : { secondaryAction: 'settings' as const, secondaryLabel: 'Settings' }),
  };
}
