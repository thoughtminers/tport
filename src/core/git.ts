import { execFileSync, execSync } from 'node:child_process';

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 10000 }).trimEnd();
  } catch {
    return '';
  }
}

export function hasGitRepo(cwd: string): boolean {
  return run('git rev-parse --is-inside-work-tree', cwd) === 'true';
}

export function getDiff(cwd: string): string {
  const unstaged = run('git diff', cwd);
  const staged = run('git diff --cached', cwd);
  return [staged, unstaged].filter(Boolean).join('\n');
}

export function getStagedDiff(cwd: string): string {
  return run('git diff --cached', cwd);
}

export function getUnstagedDiff(cwd: string): string {
  return run('git diff', cwd);
}

export function getUntrackedFiles(cwd: string): string[] {
  const raw = run('git ls-files --others --exclude-standard', cwd);
  if (!raw) return [];
  return raw.split('\n').filter(Boolean);
}

export function getStatus(cwd: string): { file: string; status: string }[] {
  const raw = run('git status --porcelain', cwd);
  if (!raw) return [];
  return raw.split('\n').map(line => ({
    status: line.slice(0, 2).trim(),
    file: line.slice(3),
  }));
}

export function getLog(
  cwd: string,
  n = 20
): { hash: string; message: string; date: string; author: string }[] {
  const raw = run(`git log --oneline --format="%h||%s||%cr||%an" -${n}`, cwd);
  if (!raw) return [];
  return raw.split('\n').map(line => {
    const [hash, message, date, author] = line.split('||');
    return { hash, message, date, author };
  });
}

export function stageFile(cwd: string, file: string): void {
  execFileSync('git', ['add', '--', file], { cwd, timeout: 10000 });
}

export function unstageFile(cwd: string, file: string): void {
  execFileSync('git', ['restore', '--staged', '--', file], {
    cwd,
    timeout: 10000,
  });
}

export function commitStaged(cwd: string, message: string): string {
  return execFileSync('git', ['commit', '-m', message], {
    cwd,
    encoding: 'utf-8',
    timeout: 30000,
  }).trimEnd();
}

export function getDiffStats(cwd: string): {
  files: number;
  additions: number;
  deletions: number;
} {
  const raw = run('git diff --shortstat', cwd);
  const stagedRaw = run('git diff --cached --shortstat', cwd);

  const parse = (s: string) => {
    const files = s.match(/(\d+) file/)?.[1] ?? '0';
    const ins = s.match(/(\d+) insertion/)?.[1] ?? '0';
    const del = s.match(/(\d+) deletion/)?.[1] ?? '0';
    return {
      files: parseInt(files, 10),
      additions: parseInt(ins, 10),
      deletions: parseInt(del, 10),
    };
  };

  const unstaged = parse(raw);
  const staged = parse(stagedRaw);

  return {
    files: unstaged.files + staged.files,
    additions: unstaged.additions + staged.additions,
    deletions: unstaged.deletions + staged.deletions,
  };
}
