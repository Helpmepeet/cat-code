import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const readerPath = join(import.meta.dir, 'gitFilesystem.ts')
const cwdPath = resolve(import.meta.dir, '../cwd.ts')
const commandPath = resolve(import.meta.dir, '../../commands/commit-push-pr.ts')

async function probe(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'engine-branch-'))
  const project = join(root, 'project')
  mkdirSync(project)
  try {
    const child = Bun.spawn([process.execPath, '--eval', `
      import assert from 'node:assert/strict';
      import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const fsGit = await import(${JSON.stringify(readerPath)});
      const { runWithCwdOverride } = await import(${JSON.stringify(cwdPath)});
      const root = process.env.PROBE_ROOT;
      const project = join(root, 'project');
      function git(...args) {
        const result = Bun.spawnSync(['git', ...args], { cwd: project, env: process.env });
        assert.equal(result.exitCode, 0, result.stderr.toString());
        return result.stdout.toString().trim();
      }
      const branchAt = cwd => runWithCwdOverride(cwd, () => fsGit.getCachedBranch());
      try {
        git('init', '--initial-branch=original');
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture');
        ${body}
      } finally {
        fsGit.resetGitFileWatcher();
      }
    `], {
      cwd: project,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        TMPDIR: root,
        NODE_ENV: 'test',
        DISABLE_TELEMETRY: '1',
        CLAUDE_CONFIG_DIR: join(root, 'config'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(root, 'empty-config'),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: join(root, 'no-hooks'),
        PROBE_ROOT: root,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stdout + stderr).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('cached metadata follows cwd into and out of worktrees, including concurrent callers', async () => {
  await probe(`
    const worktree = join(root, 'worktree');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    assert.equal(await branchAt(outside), 'HEAD');
    assert.equal(await branchAt(project), 'original');
    git('worktree', 'add', '-b', 'feature/日本語(v2)', worktree);
    assert.equal(await branchAt(worktree), 'feature/日本語(v2)');
    const subdir = join(worktree, 'nested');
    mkdirSync(subdir);
    assert.equal(await branchAt(subdir), 'feature/日本語(v2)');
    assert.equal(await branchAt(project), 'original');
    assert.equal(await branchAt(outside), 'HEAD');
    assert.deepEqual(await Promise.all([branchAt(worktree), branchAt(project)]), ['feature/日本語(v2)', 'original']);
    const headAt = cwd => runWithCwdOverride(cwd, () => fsGit.getCachedHead());
    const originalSha = await headAt(project);
    const result = Bun.spawnSync(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'worktree commit'], { cwd: worktree, env: process.env });
    assert.equal(result.exitCode, 0, result.stderr.toString());
    // A fresh checkout cache must not reuse the original checkout's SHA.
    fsGit.resetGitFileWatcher();
    assert.equal(await headAt(project), originalSha);
    assert.notEqual(await headAt(worktree), originalSha);
    assert.equal(await headAt(project), originalSha);
  `)
})

test('Git-valid branch names survive HEAD, symref, loose and packed ref reading', async () => {
  await probe(`
    const names = ['feature/日本語', 'feature/login(v2)', 'feature/$cash;and&pipes|<tag>', "feature/quote'and\\\"double", 'feature/!tick' + String.fromCharCode(96), '@', 'feature/雪\\u00a0', 'feature/emoji-🐈'];
    const gitDir = join(project, '.git');
    const sha = git('rev-parse', 'HEAD');
    for (const name of names) {
      git('check-ref-format', '--branch', name);
      git('branch', name);
      git('symbolic-ref', 'HEAD', 'refs/heads/' + name);
      fsGit.resetGitFileWatcher();
      assert.equal(await branchAt(project), name);
      assert.equal(await fsGit.resolveRef(gitDir, 'refs/heads/' + name), sha);
      git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/' + name);
      assert.equal(await fsGit.readRawSymref(gitDir, 'refs/remotes/origin/HEAD', 'refs/remotes/origin/'), name);
      assert.equal(await runWithCwdOverride(project, () => fsGit.getCachedDefaultBranch()), name);
    }
    git('pack-refs', '--all');
    for (const name of names) assert.equal(await fsGit.resolveRef(gitDir, 'refs/heads/' + name), sha);
    git('update-ref', '--no-deref', 'HEAD', sha);
    fsGit.resetGitFileWatcher();
    assert.equal(await branchAt(project), 'HEAD');
    assert.equal(await runWithCwdOverride(project, () => fsGit.getCachedHead()), sha);
    for (const name of ['../escape', 'foo/../../escape', '-option', '.hidden', 'foo/.hidden', 'foo.lock', 'foo/bar.lock', 'foo//bar', 'foo/', 'foo..bar', 'foo@{bar', 'foo.', 'foo bar', 'foo\\nbar', 'foo~bar', 'foo^bar', 'foo:bar', 'foo?bar', 'foo*bar', 'foo[bar', 'foo\\\\bar']) {
      assert.equal(fsGit.isSafeRefName(name), false, name);
      writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/' + name + '\\n');
      assert.equal(await fsGit.readGitHead(gitDir), null, name);
      assert.equal(await fsGit.resolveRef(gitDir, name), null, name);
    }
  `)
})

test('commit-push-pr quotes Git-valid shell metacharacters without breaking prompt delimiters', async () => {
  await probe(`
    // Load the command registry first, matching CLI initialization order.
    await import(${JSON.stringify(resolve(import.meta.dir, '../../commands.ts'))});
    const { getPromptContent } = await import(${JSON.stringify(commandPath)});
    const tick = String.fromCharCode(96);
    const branch = "feature/$(touch$" + "{IFS}sentinel);'!" + tick + 'pwd' + tick + '日本語';
    git('check-ref-format', '--branch', branch);
    git('branch', branch);
    const prompt = getPromptContent(branch);
    const matches = [...prompt.matchAll(/(?<=^|\\s)!\x60([^\x60]+)\x60/gm)];
    assert.equal(matches.length, 5);
    const command = matches.find(match => match[1].startsWith('git diff "$(printf'))?.[1];
    assert.ok(command);
    const result = Bun.spawnSync(['/bin/sh', '-c', command], { cwd: project, env: process.env });
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), '');
    assert.equal(existsSync(join(project, 'sentinel')), false);
  `)
})
