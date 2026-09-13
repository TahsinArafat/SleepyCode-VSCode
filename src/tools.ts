import * as vscode from 'vscode';
import * as path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { runCommand } from './git';
import { installSkillFromRepository, listInstalledSkills, listRepositorySkills, readInstalledSkill, readSkillMarkdown, resolveInstallPath, sanitizeSkillName, searchSkills } from './skills';
import { MAX_FILE_BYTES } from './types';
import type { AppConfig } from './types';
import { assertNotSecret, isDestructiveCommand, isSecret, pathInside, truncate } from './util';
import type { TerminalManager } from './terminal';
import { compareWorktrees, createWorktree, listWorktrees, mergeWorktree, removeWorktree, runInWorktree, statusOfWorktree } from './worktrees';
import type { RepoIndex, SourceCitedMemory } from './repo-index';
import { hashContent } from './repo-index';
import type { BrowserController } from './browser';
import { summarizeConsoleErrors, summarizeNetworkErrors, stringifyEvalResult } from './browser';
import { addPrComment, buildPrBody, commitChanges, createBranchForIssue, createPullRequest, getIssue, getPr, getReviewComments, listIssues, monitorChecks, repoSlug } from './github';

export interface ToolContext {
  root: vscode.Uri;
  skillsDir: vscode.Uri;
  config(): AppConfig;
  approve(kind: 'edit' | 'command', title: string, detail: string, destructive?: boolean, approvalKey?: string): Promise<void>;
  reviewEdit?(filePath: string, before: string, after: string, reason: string, destructive?: boolean): Promise<void>;
  post(message: unknown): void;
  resolvePath(filePath: string): vscode.Uri;
  describePlan(): string;
  abortSignal?: AbortSignal;
  terminals?: TerminalManager;
  delegate?: (role: 'explorer' | 'reviewer' | 'worker', task: string, context?: string) => Promise<string>;
  memory?: { path: string; read(): Promise<string>; write(content: string, reason?: string): Promise<void> };
  repoIndex?: RepoIndex;
  repoMemory?: SourceCitedMemory;
  browser?: BrowserController;
}

export function buildTools(ctx: ToolContext): Record<string, any> {
  const tools: Record<string, any> = {
    plan: tool({
      description: 'Call this first for any non-trivial task. Present the main design aspects as an ordered plan: what will change, which files are involved, and how each part will be verified. The plan is shown as a floating card pinned to the top of the chat with the currently executing step spinning and completed steps checked off. IMPORTANT: the plan tool is STATEFUL and there is NO auto-advancement - the plan NEVER moves forward on its own, and previously completed steps stay checked. The result of every call returns the complete current plan back to you, so you always know its exact state. After finishing each step you MUST re-call this tool and pass doneSteps (0-based indices of every step now completed, including the one you just finished) plus activeStep (0-based index of the step you are now working on). Pass steps and title only when creating a plan or explicitly rewriting it; progress updates may omit them.',
      inputSchema: z.object({
        title: z.string().min(1).max(120).optional().describe('Short plan title, e.g. "Add multi-provider support". Omit for progress updates on an existing plan.'),
        steps: z.array(z.string().min(1)).min(1).max(20).optional().describe('Ordered steps covering the main design aspects. Omit for progress updates on an existing plan.'),
        activeStep: z.number().int().min(0).max(20).optional().describe('0-based index of the step you are currently working on. Pass this explicitly on EVERY plan call - the index never advances on its own.'),
        doneSteps: z.array(z.number().int().min(0).max(20)).optional().describe('0-based indices of steps already completed. Include every step you just finished, or it stays unchecked; previously completed steps are merged in automatically.'),
      }),
      execute: async () => ctx.describePlan(),
    }),
    list_files: tool({
      description: 'List workspace files matching a glob. Excludes dependencies and Git metadata.',
      inputSchema: z.object({ glob: z.string().default('**/*'), limit: z.number().int().min(1).max(500).default(200) }),
      execute: async ({ glob, limit }) => {
        const files = await vscode.workspace.findFiles(glob, '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}', limit);
        return files.map(uri => path.relative(ctx.root.fsPath, uri.fsPath)).join('\n') || '(no files)';
      },
    }),
    read_file: tool({
      description: 'Read a UTF-8 text file from the workspace. Secret env files are blocked.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path: filePath }) => {
        assertNotSecret(filePath);
        const uri = ctx.resolvePath(filePath);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) throw new Error(`File is too large (${stat.size} bytes).`);
        return truncate(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
      },
    }),
    search_files: tool({
      description: 'Search text across workspace files using a plain text query.',
      inputSchema: z.object({ query: z.string().min(1), glob: z.string().default('**/*'), limit: z.number().int().min(1).max(200).default(80) }),
      execute: async ({ query, glob, limit }) => {
        const files = await vscode.workspace.findFiles(glob, '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}', 500);
        const hits: string[] = [];
        for (const uri of files) {
          if (hits.length >= limit) break;
          if (isSecret(path.relative(ctx.root.fsPath, uri.fsPath))) continue;
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size > MAX_FILE_BYTES) continue;
            const lines = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).split(/\r?\n/);
            lines.forEach((line, index) => {
              if (hits.length < limit && line.toLowerCase().includes(query.toLowerCase())) {
                hits.push(`${path.relative(ctx.root.fsPath, uri.fsPath)}:${index + 1}: ${line.trim().slice(0, 300)}`);
              }
            });
          } catch { }
        }
        return hits.join('\n') || '(no matches)';
      },
    }),
    write_file: tool({
      description: 'Create or completely replace a workspace text file. Requires user approval.',
      inputSchema: z.object({ path: z.string(), content: z.string(), reason: z.string().optional() }),
      execute: async ({ path: filePath, content, reason }) => {
        assertNotSecret(filePath);
        const uri = ctx.resolvePath(filePath);
        const edit = new vscode.WorkspaceEdit();
        let exists = true;
        try { await vscode.workspace.fs.stat(uri); } catch { exists = false; }
        const before = exists ? (await vscode.workspace.openTextDocument(uri)).getText() : '';
        if (ctx.reviewEdit) await ctx.reviewEdit(filePath, before, content, reason ?? 'The agent wants to create or replace this file.');
        else await ctx.approve('edit', `Write ${filePath}?`, reason ?? 'The agent wants to create or replace this file.');
        if (exists) {
          const document = await vscode.workspace.openTextDocument(uri);
          if (document.getText() !== before) throw new Error(`${filePath} changed while the proposed edit was being reviewed. Read it again before editing.`);
          const end = document.positionAt(document.getText().length);
          edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), content);
        } else {
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
          edit.createFile(uri, { ignoreIfExists: false });
          edit.insert(uri, new vscode.Position(0, 0), content);
        }
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the edit.');
        await vscode.workspace.saveAll(false);
        ctx.post({ type: 'changed', path: filePath, action: exists ? 'Modified' : 'Created' });
        return `Wrote ${filePath} (${content.length} characters).`;
      },
    }),
    replace_text: tool({
      description: 'Replace one exact text occurrence in a workspace file. Requires user approval.',
      inputSchema: z.object({ path: z.string(), oldText: z.string().min(1), newText: z.string(), reason: z.string().optional() }),
      execute: async ({ path: filePath, oldText, newText, reason }) => {
        assertNotSecret(filePath);
        const uri = ctx.resolvePath(filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        const source = document.getText();
        const first = source.indexOf(oldText);
        if (first < 0) throw new Error('Exact oldText was not found. Read the file again.');
        if (source.indexOf(oldText, first + oldText.length) >= 0) throw new Error('oldText occurs more than once; provide a larger unique block.');
        const proposed = source.slice(0, first) + newText + source.slice(first + oldText.length);
        if (ctx.reviewEdit) await ctx.reviewEdit(filePath, source, proposed, reason ?? 'The agent wants to replace one block of text.');
        else await ctx.approve('edit', `Edit ${filePath}?`, reason ?? 'The agent wants to replace one block of text.');
        if (document.getText() !== source) throw new Error(`${filePath} changed while the proposed edit was being reviewed. Read it again before editing.`);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(document.positionAt(first), document.positionAt(first + oldText.length)), newText);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the edit.');
        await document.save();
        ctx.post({ type: 'changed', path: filePath, action: 'Modified' });
        return `Updated ${filePath}.`;
      },
    }),
    delete_file: tool({
      description: 'Delete one workspace file. Requires user approval.',
      inputSchema: z.object({ path: z.string(), reason: z.string().optional() }),
      execute: async ({ path: filePath, reason }) => {
        assertNotSecret(filePath);
        const uri = ctx.resolvePath(filePath);
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) !== 0) throw new Error('delete_file only deletes individual files.');
        const before = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        if (ctx.reviewEdit) await ctx.reviewEdit(filePath, before, '', reason ?? 'The agent wants to delete this file.', true);
        else await ctx.approve('edit', `Delete ${filePath}?`, reason ?? 'The agent wants to delete this file.', true);
        const current = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        if (current !== before) throw new Error(`${filePath} changed while its deletion was being reviewed. Read it again before deleting.`);
        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
        ctx.post({ type: 'changed', path: filePath, action: 'Deleted' });
        return `Deleted ${filePath}.`;
      },
    }),
    get_diagnostics: tool({
      description: 'Return current VS Code errors and warnings for the workspace.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(100) }),
      execute: async ({ limit }) => {
        const rows: string[] = [];
        for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
          if (!pathInside(ctx.root.fsPath, uri.fsPath)) continue;
          for (const diagnostic of diagnostics) {
            if (rows.length >= limit) break;
            if (diagnostic.severity > vscode.DiagnosticSeverity.Warning) continue;
            rows.push(`${path.relative(ctx.root.fsPath, uri.fsPath)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.severity === 0 ? 'error' : 'warning'}: ${diagnostic.message}`);
          }
        }
        return rows.join('\n') || '(no errors or warnings)';
      },
    }),
    run_command: tool({
      description: 'Run a shell command in the workspace and return output. Destructive commands (deleting files, discarding Git changes, force-pushing, wiping data) require user approval in auto-edit mode.',
      inputSchema: z.object({ command: z.string().min(1), reason: z.string().optional(), timeoutSeconds: z.number().min(1).max(120).default(30) }),
      execute: async ({ command, reason, timeoutSeconds }) => {
        await ctx.approve('command', 'Run command?', `${command}\n\n${reason ?? ''}`, isDestructiveCommand(command), command);
        ctx.post({ type: 'command', command });
        return runCommand(command, ctx.root.fsPath, timeoutSeconds * 1000, ctx.abortSignal);
      },
    }),
  };
  const delegate = ctx.delegate;
  if (delegate) {
    tools.delegate_task = tool({
      description: 'Delegate one bounded task to an isolated specialized subagent and wait for its result. Use explorer for read-only repository research, reviewer for an independent read-only critique, and worker for focused implementation or verification. Give a precise task and only necessary context. Subagents cannot recursively delegate.',
      inputSchema: z.object({
        role: z.enum(['explorer', 'reviewer', 'worker']),
        task: z.string().trim().min(1).max(4000),
        context: z.string().max(12000).optional().describe('Only the context the subagent needs; it does not receive the parent conversation.'),
      }),
      execute: async ({ role, task, context }) => delegate(role, task, context),
    });
  }
  if (ctx.terminals) {
    tools.terminal_start = tool({
      description: 'Start a named persistent shell session in the workspace. The session remains available across tool calls and conversations until stopped or VS Code closes.',
      inputSchema: z.object({ name: z.string().min(1).max(60), command: z.string().optional() }),
      execute: async ({ name, command }) => {
        if (command?.trim()) await ctx.approve('command', `Start terminal '${name}'?`, command, isDestructiveCommand(command), command);
        return ctx.terminals?.start(name, ctx.root.fsPath, command);
      },
    });
    tools.terminal_write = tool({
      description: 'Write input to a persistent terminal. Include a trailing newline to submit a shell command.',
      inputSchema: z.object({ name: z.string().min(1), input: z.string().min(1) }),
      execute: async ({ name, input }) => {
        await ctx.approve('command', `Write to terminal '${name}'?`, input, isDestructiveCommand(input), input);
        return ctx.terminals?.write(name, input);
      },
    });
    tools.terminal_read = tool({
      description: 'Read output from a persistent terminal. Pass the returned cursor on the next read to receive only new output.',
      inputSchema: z.object({ name: z.string().min(1), cursor: z.number().int().min(0).default(0) }),
      execute: async ({ name, cursor }) => JSON.stringify(ctx.terminals?.read(name, cursor), null, 2),
    });
    tools.terminal_list = tool({
      description: 'List persistent terminal sessions and whether each is still running.',
      inputSchema: z.object({}),
      execute: async () => JSON.stringify(ctx.terminals?.list() ?? [], null, 2),
    });
    tools.terminal_stop = tool({
      description: 'Stop one persistent terminal session.',
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: async ({ name }) => ctx.terminals?.stop(name),
    });
  }
  if (ctx.memory) {
    tools.memory_read = tool({
      description: 'Read durable project memory containing established decisions, conventions, and user preferences.',
      inputSchema: z.object({}),
      execute: async () => (await ctx.memory?.read()) || '(project memory is empty)',
    });
    tools.memory_update = tool({
      description: 'Replace durable project memory after reading it. Preserve useful existing entries, keep it concise, and never store credentials or secrets.',
      inputSchema: z.object({ content: z.string().max(24_000), reason: z.string().optional() }),
      execute: async ({ content, reason }) => {
        await ctx.memory?.write(content, reason);
        ctx.post({ type: 'changed', path: ctx.memory?.path });
        return `Updated ${ctx.memory?.path}.`;
      },
    });
  }
  tools.skillsmp_search = tool({
    description: 'Search the SkillsMP marketplace for installable AI agent skills (SKILL.md packages). Returns each result with its name, description, star count, author, GitHub source URL, and marketplace URL. Use the returned GitHub source as the source for skillsmp_install_skill or skillsmp_get_skill.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Search keywords, e.g. "react testing", "web scraper", "seo".'),
      limit: z.number().int().min(1).max(50).default(10).describe('Maximum results to return.'),
      sortBy: z.enum(['stars', 'recent']).default('stars').describe('Sort results by stars or by most recently updated.'),
    }),
    execute: async ({ query, limit, sortBy }) => {
      const { skills, total } = await searchSkills(query, { limit, sortBy }, ctx.abortSignal);
      if (!skills.length) return `No skills found for '${query}'. Try different keywords.`;
      return `Found ${total} skills for '${query}' (showing ${skills.length}):\n\n${skills.map((skill, index) => `${index + 1}. ${skill.name} ⭐${skill.stars} by ${skill.author}\n${skill.description}\nGitHub: ${skill.githubUrl || '(unknown)'}\nMarketplace: ${skill.skillUrl}`).join('\n\n')}`;
    },
  });
  tools.skillsmp_list_repo_skills = tool({
    description: `List the installable skills (SKILL.md folders) available in a GitHub repository. Pass 'owner/repo' or a github.com URL. Use this to discover the exact skill folder name needed by skillsmp_install_skill when you only know the repository.`,
    inputSchema: z.object({
      source: z.string().min(1).describe('GitHub repository, e.g. "davila7/claude-code-templates" or "https://github.com/davila7/claude-code-templates".'),
      branch: z.string().default('main').describe('Git branch (falls back to main/master).'),
    }),
    execute: async ({ source, branch }) => {
      const reference = resolveInstallPath(source, '', branch);
      const skills = await listRepositorySkills(reference.owner, reference.repo, reference.branch, ctx.abortSignal);
      if (!skills.length) return `No SKILL.md skills found in ${reference.owner}/${reference.repo}.`;
      const shown = skills.slice(0, 120);
      return `${reference.owner}/${reference.repo} has ${skills.length} skills (showing the first ${shown.length}):\n\n${shown.map(skill => `- ${skill.name} (${skill.path})`).join('\n')}${skills.length > shown.length ? `\n… and ${skills.length - shown.length} more.` : ''}`;
    },
  });
  tools.skillsmp_get_skill = tool({
    description: `Preview a skill's SKILL.md content from a GitHub repository before installing it. Pass the GitHub source from skillsmp_search results (which already points at the skill folder), or pass 'owner/repo' plus the skill's folder path from skillsmp_list_repo_skills. If only a repository is given, lists its skills instead.`,
    inputSchema: z.object({
      source: z.string().min(1).describe('GitHub source: a github.com URL with skill path, or "owner/repo".'),
      path: z.string().optional().describe('Skill folder path inside the repository (omit when source already includes it).'),
      branch: z.string().default('main').describe('Git branch (falls back to main/master).'),
    }),
    execute: async ({ source, path: extraPath, branch }) => {
      const reference = resolveInstallPath(source, '', branch);
      const folderPath = extraPath ?? reference.folderPath ?? '';
      if (!folderPath) {
        const skills = await listRepositorySkills(reference.owner, reference.repo, reference.branch, ctx.abortSignal);
        if (!skills.length) return `No SKILL.md skills found in ${reference.owner}/${reference.repo}.`;
        const shown = skills.slice(0, 120);
        return `No skill path given. Skills available in ${reference.owner}/${reference.repo} (${skills.length} total):\n\n${shown.map(skill => `- ${skill.name} (${skill.path})`).join('\n')}${skills.length > shown.length ? `\n… and ${skills.length - shown.length} more.` : ''}`;
      }
      const { content } = await readSkillMarkdown(reference.owner, reference.repo, reference.branch, folderPath, ctx.abortSignal);
      return `# ${reference.owner}/${reference.repo} / ${folderPath}\n\n${truncate(content)}`;
    },
  });
  tools.skillsmp_install_skill = tool({
    description: `Install a skill from a GitHub repository into your global skills folder (Agent Skills format, available in every workspace). Requires user approval. Pass the GitHub source from skillsmp_search results, or 'owner/repo' plus the skill name discovered by skillsmp_list_repo_skills. The skill is then listed in the agent's instructions so it can be applied in this and future requests.`,
    inputSchema: z.object({
      source: z.string().min(1).describe('GitHub source: a github.com URL that points at the skill folder, or "owner/repo".'),
      skill: z.string().optional().describe('Skill folder name inside the repository when source is just "owner/repo".'),
      branch: z.string().default('main').describe('Git branch (falls back to main/master).'),
    }),
    execute: async ({ source, skill, branch }) => {
      const reference = resolveInstallPath(source, skill ?? '', branch);
      let folderPath = reference.folderPath;
      if (!folderPath) {
        const skills = await listRepositorySkills(reference.owner, reference.repo, reference.branch, ctx.abortSignal);
        const match = skill
          ? skills.find(candidate => candidate.name === sanitizeSkillName(skill) || candidate.name.toLowerCase() === skill.trim().toLowerCase())
          : undefined;
        if (!match) {
          const shown = skills.slice(0, 120);
          return skills.length
            ? `${reference.owner}/${reference.repo} has ${skills.length} skills. Pick one and pass its name: ${shown.map(candidate => `${candidate.name} (${candidate.path})`).join(', ')}${skills.length > shown.length ? `, …(+${skills.length - shown.length} more)` : ''}`
            : `No SKILL.md skills found in ${reference.owner}/${reference.repo}.`;
        }
        folderPath = match.path;
      }
      const installName = sanitizeSkillName(reference.hintedName ?? folderPath.split('/').pop() ?? skill ?? 'skill');
      await ctx.approve('edit', `Install skill "${installName}"?`, `Source: ${reference.owner}/${reference.repo}${folderPath ? ` (${folderPath})` : ' (repository root)'}\n\nThe skill will be installed into your global skills folder as '${installName}' and is available in every workspace. Its SKILL.md will be added to the agent's instructions on every future request and can direct file edits and commands. Only install skills from trusted authors.`);
      const result = await installSkillFromRepository(ctx.skillsDir, { owner: reference.owner, repo: reference.repo, branch: reference.branch, folderPath, installName }, ctx.abortSignal);
      ctx.post({ type: 'changed', path: result.skillMdPath });
      return `Installed skill '${result.name}' (${result.files} files, ${result.bytes} bytes) from ${reference.owner}/${reference.repo} into your global skills folder.\nRead ${result.skillMdPath} before applying the skill. It is offered to the agent automatically from the next request on.`;
    },
  });
  tools.skillsmp_list_installed = tool({
    description: `List the skills currently installed in your global skills folder. Use this when asked about available skills or before applying one.`,
    inputSchema: z.object({}),
    execute: async () => {
      const installed = await listInstalledSkills(ctx.skillsDir);
      if (!installed.length) return `No skills installed yet. Use skillsmp_search to find one and skillsmp_install_skill to add it.`;
      return installed.map(skill => `- ${skill.name}: ${skill.description || '(no description)'} (${skill.folder})`).join('\n');
    },
  });
  tools.skillsmp_read_installed = tool({
    description: `Read an installed skill's local SKILL.md before applying it. Use this whenever the user names an installed skill or a request clearly matches one listed in the agent instructions.`,
    inputSchema: z.object({
      name: z.string().min(1).describe('Installed skill name or folder, exactly as listed by skillsmp_list_installed when possible.'),
    }),
    execute: async ({ name }) => {
      const { skill, content } = await readInstalledSkill(ctx.skillsDir, name);
      return `# Installed skill: ${skill.name}\n\n${truncate(content)}`;
    },
  });
  tools.worktree_create = tool({
    description: 'Create an isolated Git worktree with its own branch for parallel work. Returns the worktree name and path. Requires a Git repository.',
    inputSchema: z.object({
      name: z.string().min(1).max(60).describe('Short worktree name, e.g. "feature-auth".'),
      branch: z.string().optional().describe('Branch name to create; defaults to a sleepycode-derived name.'),
      base: z.string().optional().describe('Git ref to branch from; defaults to HEAD.'),
    }),
    execute: async ({ name, branch, base }) => {
      await ctx.approve('command', `Create worktree "${name}"?`, `Creates a new Git worktree under ${'.sleepycode/worktrees'}.`);
      const tree = await createWorktree(ctx.root.fsPath, { name, branch, base });
      return JSON.stringify(tree, null, 2);
    },
  });
  tools.worktree_list = tool({
    description: 'List all Git worktrees for the workspace with their branch and commit.',
    inputSchema: z.object({}),
    execute: async () => JSON.stringify(await listWorktrees(ctx.root.fsPath), null, 2),
  });
  tools.worktree_status = tool({
    description: 'Show status of one Git worktree: dirty state, untracked files, and ahead/behind counts.',
    inputSchema: z.object({ name: z.string().min(1) }),
    execute: async ({ name }) => JSON.stringify(await statusOfWorktree(ctx.root.fsPath, name), null, 2),
  });
  tools.worktree_compare = tool({
    description: 'Compare two worktrees and return the diff stat between their commits.',
    inputSchema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
    execute: async ({ from, to }) => JSON.stringify(await compareWorktrees(ctx.root.fsPath, from, to), null, 2),
  });
  tools.worktree_merge = tool({
    description: 'Merge a worktree branch into another worktree (default: main). Returns conflicts if the merge did not complete cleanly. Requires user approval.',
    inputSchema: z.object({
      name: z.string().min(1).describe('Source worktree to merge from.'),
      into: z.string().default('(main)').describe('Target worktree to merge into.'),
      strategy: z.enum(['merge', 'squash', 'rebase']).default('merge'),
    }),
    execute: async ({ name, into, strategy }) => {
      await ctx.approve('command', `Merge worktree "${name}" into "${into}"?`, `Strategy: ${strategy}`, true);
      return JSON.stringify(await mergeWorktree(ctx.root.fsPath, name, into, strategy), null, 2);
    },
  });
  tools.worktree_remove = tool({
    description: 'Remove a Git worktree and delete its branch. Requires user approval.',
    inputSchema: z.object({ name: z.string().min(1), force: z.boolean().default(false) }),
    execute: async ({ name, force }) => {
      await ctx.approve('command', `Remove worktree "${name}"?`, 'Deletes the worktree directory and its branch.', true);
      await removeWorktree(ctx.root.fsPath, name, force);
      return `Removed worktree ${name}.`;
    },
  });
  tools.worktree_run = tool({
    description: 'Run a shell command inside a specific worktree directory and return its output.',
    inputSchema: z.object({ name: z.string().min(1), command: z.string().min(1), timeoutSeconds: z.number().min(1).max(600).default(120) }),
    execute: async ({ name, command, timeoutSeconds }) => {
      await ctx.approve('command', `Run in worktree "${name}"?`, command, isDestructiveCommand(command), command);
      const result = await runInWorktree(ctx.root.fsPath, name, command, timeoutSeconds * 1000);
      return `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ''}`.trim() || `(command exited ${result.code})`;
    },
  });
  if (ctx.repoIndex) {
    const index = ctx.repoIndex;
    tools.repo_search = tool({
      description: 'Rank workspace files by semantic relevance (TF-IDF) to a natural-language query and return each file with a matching snippet. Use for "where is X implemented" style questions.',
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(30).default(10) }),
      execute: async ({ query, limit }) => {
        const results = index.semanticSearch(query, limit);
        if (!results.length) return '(no relevant files found)';
        return results.map((r, i) => `${i + 1}. ${r.path} (score ${r.score})\n   ${r.snippet}`).join('\n');
      },
    });
    tools.repo_symbol = tool({
      description: 'Search indexed workspace symbols (functions, classes, interfaces, types) by name. Returns file, line, and kind.',
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(50).default(25) }),
      execute: async ({ query, limit }) => {
        const symbols = index.indexSymbols().length ? index.symbolSearch(query, limit) : [];
        if (!symbols.length) return `(no symbols matching '${query}')`;
        return symbols.map((s) => `${s.path}:${s.line}  ${s.kind} ${s.name}`).join('\n');
      },
    });
    tools.repo_architecture = tool({
      description: 'Return the workspace import graph: files and packages as nodes, imports as edges. Use to understand module structure and dependencies.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(500).default(200) }),
      execute: async ({ limit }) => {
        const map = index.architectureMap();
        const edges = map.edges.slice(0, limit).map((e) => `${e.from} -> ${e.to}`);
        return `files indexed: ${index.files.length}\nnodes: ${map.nodes.length}, edges: ${map.edges.length}\n\n${edges.join('\n')}`;
      },
    });
  }
  if (ctx.repoMemory) {
    const repoMemory = ctx.repoMemory;
    tools.repo_memory_record = tool({
      description: 'Record a durable fact about the codebase with its source file (and optional line) so it can be invalidated automatically if that file changes.',
      inputSchema: z.object({ text: z.string().min(1).max(2000), source: z.string().min(1), line: z.number().int().min(1).optional() }),
      execute: async ({ text, source, line }) => {
        const content = ctx.repoIndex?.files.find((f) => f.path === source)?.content;
        const hash = typeof content === 'string' ? hashContent(content) : undefined;
        const fact = repoMemory.record({ text, source, line, sourceHash: hash });
        return `Recorded fact ${fact.id} from ${source}${line ? `:${line}` : ''}.`;
      },
    });
    tools.repo_memory_list = tool({
      description: 'List recorded codebase facts and whether each is still valid against its source file.',
      inputSchema: z.object({}),
      execute: async () => repoMemory.all.length ? repoMemory.all.map((f) => `${f.valid ? '✓' : '✗'} ${f.source}${f.line ? `:${f.line}` : ''} — ${f.text}`).join('\n') : '(no facts recorded)',
    });
  }
  if (ctx.browser) {
    const browser = ctx.browser;
    const browserRun = (fn: () => Promise<string>): Promise<string> => fn().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const hint = error && typeof error === 'object' && typeof (error as { installHint?: unknown }).installHint === 'string' ? (error as { installHint: string }).installHint : '';
      return hint ? `${message}\n\n${hint}` : message;
    });
    // Best-effort live preview: a capture failure must never fail the browser tool it follows.
    const postBrowserPreview = async (cursorSelector?: string): Promise<void> => {
      try {
        const dataUrl = await browser.previewDataUrl();
        if (!dataUrl) return;
        const cursor = cursorSelector ? await browser.cursorPoint(cursorSelector).catch(() => undefined) : undefined;
        ctx.post({ type: 'browserPreview', dataUrl, cursor });
      } catch { /* preview is optional */ }
    };
    // Trailing-debounced capture for tools that mutate the page without a natural
    // refresh point (type/press/scroll/wait/evaluate) so rapid sequences coalesce
    // into a single preview update instead of one screenshot per tool call.
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleBrowserPreview = (): void => {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        void postBrowserPreview();
      }, 120);
    };
    const cancelBrowserPreview = (): void => {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = undefined;
    };
    tools.browser_launch = tool({
      description: 'Launch a headless browser and open a URL. Returns the page title plus any console errors and failed network requests. Uses Playwright Chromium, or automatically falls back to system Chrome, Edge, Brave, or Firefox when no Playwright browser is installed.',
      inputSchema: z.object({
        url: z.string().min(1).describe('URL to open (http(s):// or a file:// path).'),
        viewport: z.enum(['mobile', 'tablet', 'laptop', 'desktop']).default('laptop'),
        waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load'),
      }),
      execute: async ({ url, viewport, waitUntil }) => browserRun(async () => {
        await browser.launch({ url, viewport, waitUntil });
        await postBrowserPreview();
        const snap = await browser.snapshot();
        const { errors } = summarizeConsoleErrors(snap.console);
        return JSON.stringify({ title: snap.title, url: snap.url, consoleErrors: errors.slice(0, 20), failedRequests: summarizeNetworkErrors(snap.network).slice(0, 20) }, null, 2);
      }),
    });
    tools.browser_snapshot = tool({
      description: 'Return the current page DOM, accessibility tree, console messages, and network requests as evidence about what rendered. Pass frame to inspect an iframe instead of the main page.',
      inputSchema: z.object({ includeDom: z.boolean().default(false), frame: z.string().optional().describe('Optional iframe target: URL substring or frame index (0 = main page). Omit for the main page.') }),
      execute: async ({ includeDom, frame }) => browserRun(async () => {
        const snap = await browser.snapshot(frame);
        return JSON.stringify({ title: snap.title, url: snap.url, accessibility: snap.accessibility, console: snap.console.slice(-50), network: summarizeNetworkErrors(snap.network).slice(0, 30), dom: includeDom ? snap.dom.slice(0, 20_000) : undefined }, null, 2);
      }),
    });
    tools.browser_navigate = tool({
      description: 'Navigate the active browser session to a new URL.',
      inputSchema: z.object({ url: z.string().min(1) }),
      execute: async ({ url }) => browserRun(async () => { await browser.navigate(url); await postBrowserPreview(); return `Navigated to ${url}.`; }),
    });
    tools.browser_click = tool({
      description: 'Click an element by selector. Supports Playwright engine selectors: CSS, text=Login, role=button[name="Save"], #shadowRoot >> button, .item >> nth=2.',
      inputSchema: z.object({ selector: z.string().min(1), frame: z.string().optional().describe('Optional iframe target: URL substring or frame index. Omit for the main page.') }),
      execute: async ({ selector, frame }) => browserRun(async () => { await browser.click(selector, frame); await postBrowserPreview(selector); return `Clicked ${selector}.`; }),
    });
    tools.browser_type = tool({
      description: 'Type text into an element by selector (focuses, clears existing text, then types). Supports Playwright engine selectors like text= and role=.',
      inputSchema: z.object({ selector: z.string().min(1), text: z.string(), clear: z.boolean().default(true), frame: z.string().optional().describe('Optional iframe target: URL substring or frame index. Omit for the main page.') }),
      execute: async ({ selector, text, clear, frame }) => browserRun(async () => { await browser.type(selector, text, { clear }, frame); scheduleBrowserPreview(); return `Typed into ${selector}.`; }),
    });
    tools.browser_press = tool({
      description: 'Press a keyboard key (e.g. Enter, Tab, Escape), optionally focused on a selector first. Supports Playwright engine selectors.',
      inputSchema: z.object({ key: z.string().min(1), selector: z.string().optional(), frame: z.string().optional().describe('Optional iframe target: URL substring or frame index. Requires selector.') }),
      execute: async ({ key, selector, frame }) => browserRun(async () => { await browser.press(key, selector, frame); scheduleBrowserPreview(); return `Pressed ${key}.`; }),
    });
    tools.browser_evaluate = tool({
      description: 'Evaluate a JavaScript expression in the page and return the result as JSON. Expressions returning promises are awaited. Function bodies are NOT allowed — use an IIFE: (() => { ... })(). Use to read state, computed styles, localStorage, or run verification code the other tools cannot.',
      inputSchema: z.object({ script: z.string().min(1).describe('JavaScript expression to evaluate (IIFE for statements).'), frame: z.string().optional().describe('Optional iframe target: URL substring or frame index. Omit for the main page.') }),
      execute: async ({ script, frame }) => browserRun(async () => { const result = stringifyEvalResult(await browser.evaluate(script, frame)); scheduleBrowserPreview(); return result; }),
    });
    tools.browser_wait = tool({
      description: 'Wait for an element to reach a state, or pause for a fixed duration. Use before interacting with elements that load asynchronously.',
      inputSchema: z.object({
        selector: z.string().optional().describe('Element to wait for. Mutually exclusive with ms.'),
        state: z.enum(['visible', 'hidden', 'attached', 'detached']).default('visible'),
        timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
        ms: z.number().int().min(0).max(60_000).optional().describe('Pause for this many milliseconds instead of waiting for a selector.'),
      }),
      execute: async ({ selector, state, timeoutMs, ms }) => browserRun(async () => {
        if ((selector && ms !== undefined) || (!selector && ms === undefined)) throw new Error('browser_wait needs exactly one of: selector, or ms.');
        const result = await browser.wait(selector, state, timeoutMs, ms);
        scheduleBrowserPreview();
        return result;
      }),
    });
    tools.browser_back = tool({
      description: 'Go back one step in history. Returns whether navigation happened.',
      inputSchema: z.object({ waitUntil: z.enum(['load', 'domcontentloaded']).default('load') }),
      execute: async ({ waitUntil }) => browserRun(async () => { const r = await browser.back({ waitUntil }); await postBrowserPreview(); return JSON.stringify(r); }),
    });
    tools.browser_forward = tool({
      description: 'Go forward one step in history. Returns whether navigation happened.',
      inputSchema: z.object({ waitUntil: z.enum(['load', 'domcontentloaded']).default('load') }),
      execute: async ({ waitUntil }) => browserRun(async () => { const r = await browser.forward({ waitUntil }); await postBrowserPreview(); return JSON.stringify(r); }),
    });
    tools.browser_reload = tool({
      description: 'Reload the current page.',
      inputSchema: z.object({ waitUntil: z.enum(['load', 'domcontentloaded']).default('load') }),
      execute: async ({ waitUntil }) => browserRun(async () => { const r = await browser.reload({ waitUntil }); await postBrowserPreview(); return JSON.stringify(r); }),
    });
    tools.browser_new_tab = tool({
      description: 'Open a new tab in the active browser session and switch to it. Omit url for a blank tab (e.g. for a same-origin window).',
      inputSchema: z.object({ url: z.string().optional().describe('URL to open in the new tab.') }),
      execute: async ({ url }) => browserRun(async () => { cancelBrowserPreview(); const tab = await browser.newTab(url); if (url) await postBrowserPreview(); return JSON.stringify(tab); }),
    });
    tools.browser_list_tabs = tool({
      description: 'List all open tabs with their index, url, title, and which is active.',
      inputSchema: z.object({}),
      execute: async () => browserRun(async () => JSON.stringify(await browser.listTabs(), null, 2)),
    });
    tools.browser_switch_tab = tool({
      description: 'Switch the active tab. target is a numeric index, or a URL/title substring (must match exactly one tab).',
      inputSchema: z.object({ target: z.union([z.number().int().min(0), z.string().min(1)]) }),
      execute: async ({ target }) => browserRun(async () => { const tab = await browser.switchTab(target); await postBrowserPreview(); return JSON.stringify(tab); }),
    });
    tools.browser_close_tab = tool({
      description: 'Close the ACTIVE tab and switch to the remaining tab closest to it. Errors if it is the only tab (use browser_close to end the session).',
      inputSchema: z.object({}),
      execute: async () => browserRun(async () => { const tabs = await browser.closeTab(); await postBrowserPreview(); return JSON.stringify(tabs, null, 2); }),
    });
    tools.browser_scroll = tool({
      description: 'Scroll the page: pass a selector to bring an element into view, and/or deltaY pixels to scroll by. Supports Playwright engine selectors.',
      inputSchema: z.object({ selector: z.string().optional(), deltaY: z.number().int().optional(), frame: z.string().optional().describe('Optional iframe target: URL substring or frame index. Omit for the main page.') }),
      execute: async ({ selector, deltaY, frame }) => browserRun(async () => {
        if (!selector && deltaY === undefined) throw new Error('browser_scroll needs either selector or deltaY.');
        const result = await browser.scroll(selector, deltaY, frame);
        scheduleBrowserPreview();
        return result;
      }),
    });
    tools.browser_geometry = tool({
      description: 'Measure responsive layout at a viewport: horizontal overflow and elements that spill off-screen. Use to catch broken layouts.',
      inputSchema: z.object({ viewport: z.enum(['mobile', 'tablet', 'laptop', 'desktop']).default('mobile') }),
      execute: async ({ viewport }) => browserRun(async () => JSON.stringify(await browser.collectGeometry(viewport), null, 2)),
    });
    tools.browser_screenshot = tool({
      description: 'Capture a full-page screenshot of the active session to a workspace-relative path.',
      inputSchema: z.object({ path: z.string().min(1) }),
      execute: async ({ path: target }) => browserRun(async () => `Saved ${await browser.screenshot(ctx.resolvePath(target).fsPath)}.`),
    });
    tools.browser_close = tool({
      description: 'Close the active browser session and all its tabs.',
      inputSchema: z.object({}),
      execute: async () => browserRun(async () => { cancelBrowserPreview(); await browser.close(); ctx.post({ type: 'browserPreview', dataUrl: '' }); return 'Browser session closed.'; }),
    });
  }
  tools.github_list_issues = tool({
    description: 'List GitHub issues for the workspace origin repository via the GitHub CLI. Requires `gh` installed and authenticated.',
    inputSchema: z.object({ state: z.enum(['open', 'closed', 'all']).default('open'), limit: z.number().int().min(1).max(100).default(30) }),
    execute: async ({ state, limit }) => {
      const issues = (await listIssues(ctx.root.fsPath, state)).slice(0, limit);
      if (!issues.length) return `(no ${state} issues)`;
      return issues.map((i) => `#${i.number} ${i.title} [${i.state}]${i.labels.length ? ` (${i.labels.join(', ')})` : ''}\n${i.url}`).join('\n\n');
    },
  });
  tools.github_get_issue = tool({
    description: 'Fetch one GitHub issue (title, body, labels, assignees) by number.',
    inputSchema: z.object({ number: z.number().int().min(1) }),
    execute: async ({ number }) => {
      const issue = await getIssue(ctx.root.fsPath, number);
      return `#${issue.number} ${issue.title}\nState: ${issue.state}\nLabels: ${issue.labels.join(', ') || '(none)'}\nAssignees: ${issue.assignees.join(', ') || '(none)'}\n${issue.url}\n\n${issue.body}`;
    },
  });
  tools.github_start_from_issue = tool({
    description: 'Create and check out a branch for a GitHub issue (fix/<number>-<slug>). Requires user approval.',
    inputSchema: z.object({ number: z.number().int().min(1), base: z.string().default('main') }),
    execute: async ({ number, base }) => {
      const issue = await getIssue(ctx.root.fsPath, number);
      await ctx.approve('command', `Create branch for issue #${number}?`, `Branch: fix/${number}-<slug> from ${base}`, false);
      return `Created branch ${await createBranchForIssue(ctx.root.fsPath, number, issue.title, base)}.`;
    },
  });
  tools.github_commit = tool({
    description: 'Stage and commit workspace changes with a message (used before opening a PR). Requires user approval.',
    inputSchema: z.object({ message: z.string().min(1), files: z.array(z.string()).default([]) }),
    execute: async ({ message, files }) => {
      await ctx.approve('command', 'Commit changes?', `${message}\n\nFiles: ${files.length ? files.join(', ') : 'all changes'}`, false);
      await commitChanges(ctx.root.fsPath, message, files);
      return `Committed: ${message}`;
    },
  });
  tools.github_open_pr = tool({
    description: 'Push the current branch and open a GitHub pull request. Builds a body with a summary and Closes #issue. Requires user approval.',
    inputSchema: z.object({ branch: z.string().min(1), title: z.string().min(1), summary: z.string().default(''), issueNumber: z.number().int().min(1).optional(), base: z.string().default('main'), draft: z.boolean().default(false), checklist: z.array(z.string()).default([]) }),
    execute: async ({ branch, title, summary, issueNumber, base, draft, checklist }) => {
      await ctx.approve('command', `Open pull request "${title}"?`, `Push ${branch} and open a PR into ${base}.`, false);
      const body = issueNumber ? buildPrBody(issueNumber, summary || title, checklist) : summary || title;
      const pr = await createPullRequest(ctx.root.fsPath, { branch, base, title, body, draft });
      return `Opened PR #${pr.number} (${pr.state}): ${pr.url}`;
    },
  });
  tools.github_pr_status = tool({
    description: 'Show a pull request and its CI check results. Reports failing checks to guide fixes.',
    inputSchema: z.object({ number: z.number().int().min(1).optional() }),
    execute: async ({ number }) => {
      const pr = await getPr(ctx.root.fsPath, number);
      const checks = await monitorChecks(ctx.root.fsPath, number);
      const failed = checks.filter((c) => c.status === 'failure' || c.conclusion === 'failure');
      return `PR #${pr.number}: ${pr.title} [${pr.state}] ${pr.headRefName} -> ${pr.baseRefName}\n${pr.url}\nChecks: ${checks.length} total, ${failed.length} failing\n${checks.map((c) => `- ${c.name}: ${c.status}${c.conclusion ? ` (${c.conclusion})` : ''}`).join('\n')}`;
    },
  });
  tools.github_review_comments = tool({
    description: 'Fetch review comments on a pull request, with file path and line when available.',
    inputSchema: z.object({ number: z.number().int().min(1) }),
    execute: async ({ number }) => {
      const comments = await getReviewComments(ctx.root.fsPath, number);
      if (!comments.length) return `(no review comments on PR #${number})`;
      return comments.map((c) => `${c.author}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}:\n${c.body}`).join('\n\n');
    },
  });
  tools.github_pr_comment = tool({
    description: 'Post a comment on a pull request. Requires user approval.',
    inputSchema: z.object({ number: z.number().int().min(1), body: z.string().min(1) }),
    execute: async ({ number, body }) => {
      const slug = await repoSlug(ctx.root.fsPath);
      await ctx.approve('command', `Comment on PR #${number}?`, `${'in ' + slug}\n\n${body}`, false);
      await addPrComment(ctx.root.fsPath, number, body);
      return `Commented on PR #${number}.`;
    },
  });
  const endpoint = ctx.config().searxngUrl;
  if (endpoint) {
    tools.web_search = tool({
      description: 'Search the web through the user-configured SearXNG instance and return result titles, URLs, and snippets.',
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).default(5) }),
      execute: async ({ query, limit }) => {
        const url = `${endpoint.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
        const response = await fetch(url, { signal: ctx.abortSignal, headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}. Make sure JSON output is enabled.`);
        const payload = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
        return (payload.results ?? []).slice(0, limit).map((result, index) => `${index + 1}. ${result.title ?? 'Untitled'}\n${result.url ?? ''}\n${result.content ?? ''}`).join('\n\n') || '(no results)';
      },
    });
  }
  return tools;
}
