import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPointer, inspectPointer, planPointer } from '../src/engine/pointer.js';

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'foster-point-'));
}

function dir(base: string, name: string): string {
  const made = path.join(base, name);
  mkdirSync(made, { recursive: true });
  return made;
}

/** Whether this run may create a file symlink — elevation-gated on Windows. */
function canSymlinkFiles(): boolean {
  const base = scratch();
  const target = path.join(base, 'probe.txt');
  writeFileSync(target, 'probe');
  try {
    symlinkSync(target, path.join(base, 'probe-link'), 'file');
    return true;
  } catch {
    return false;
  }
}

describe('inspectPointer', () => {
  it('reports a path that is not there', () => {
    expect(inspectPointer(path.join(scratch(), 'nope')).kind).toBe('missing');
  });

  it('reports a real directory as a directory, not a link', () => {
    const base = scratch();
    expect(inspectPointer(dir(base, 'real')).kind).toBe('directory');
  });

  // Creating a file symlink on Windows needs elevation or developer mode, which
  // a test run cannot assume. Skipped rather than faked: a fixture that cannot
  // be built is not a reason to assert against a different shape than the one
  // the bug is about.
  it.skipIf(!canSymlinkFiles())('calls a symlink to a file a file, so the refusal can fire', () => {
    // isSymbolicLink is equally true of a link to a file. Reporting that as a
    // junction lets it past the 'file' blocker and into removeSafely, deleting
    // a link the user made.
    const base = scratch();
    const target = path.join(base, 'notes.txt');
    writeFileSync(target, 'mine');
    const link = path.join(base, 'live');
    symlinkSync(target, link, 'file');

    expect(inspectPointer(link).kind).toBe('file');
    expect(planPointer(link, dir(base, 'account-a')).blockers[0]).toContain('is a file');
    expect(applyPointer(planPointer(link, dir(base, 'account-a'))).ok).toBe(false);
    expect(existsSync(link)).toBe(true);
  });

  it('reads what a junction points at, without the reparse prefix', () => {
    const base = scratch();
    const target = dir(base, 'account-a');
    const link = path.join(base, 'live');
    symlinkSync(target, link, 'junction');

    const state = inspectPointer(link);

    expect(state.kind).toBe('junction');
    // Windows hands back the verbatim \\?\ form; leaving it in makes every
    // comparison downstream fail against a path anybody actually typed.
    expect(state.target).not.toMatch(/^\\\\\?\\/);
    expect(path.resolve(state.target!)).toBe(path.resolve(target));
  });
});

describe('planPointer', () => {
  it('refuses a target that is not a directory', () => {
    const base = scratch();
    expect(planPointer(path.join(base, 'live'), path.join(base, 'ghost')).blockers[0]).toContain(
      'not a directory',
    );
  });

  it('refuses to delete a real directory standing where the link should be', () => {
    const base = scratch();
    const standing = dir(base, 'live');
    writeFileSync(path.join(standing, 'someones-work.txt'), 'do not delete me');

    const plan = planPointer(standing, dir(base, 'account-a'));

    expect(plan.blockers[0]).toContain('real directory');
  });

  it('says nothing to do when it already points there', () => {
    const base = scratch();
    const target = dir(base, 'account-a');
    const link = path.join(base, 'live');
    symlinkSync(target, link, 'junction');

    expect(planPointer(link, target).blockers[0]).toContain('already points at');
  });
});

describe('applyPointer', () => {
  it('creates the link where there was none', () => {
    const base = scratch();
    const target = dir(base, 'account-a');
    const link = path.join(base, 'live');

    const outcome = applyPointer(planPointer(link, target));

    expect(outcome.ok).toBe(true);
    expect(path.resolve(inspectPointer(link).target!)).toBe(path.resolve(target));
  });

  it('flips an existing junction from one client to another', () => {
    const base = scratch();
    const a = dir(base, 'account-a');
    const b = dir(base, 'account-b');
    writeFileSync(path.join(b, 'marker.txt'), 'b');
    const link = path.join(base, 'live');
    symlinkSync(a, link, 'junction');

    expect(applyPointer(planPointer(link, b)).ok).toBe(true);
    // Reading through the link is the only proof that matters: this is what a
    // process with CLAUDE_CONFIG_DIR set to the link would see.
    expect(readFileSync(path.join(link, 'marker.txt'), 'utf8')).toBe('b');
  });

  it('leaves the old target’s contents alone when it flips away', () => {
    const base = scratch();
    const a = dir(base, 'account-a');
    writeFileSync(path.join(a, 'credential.txt'), 'still here');
    const link = path.join(base, 'live');
    symlinkSync(a, link, 'junction');

    applyPointer(planPointer(link, dir(base, 'account-b')));

    // Removing a junction must unlink the link, never walk into what it pointed at.
    expect(existsSync(path.join(a, 'credential.txt'))).toBe(true);
  });

  it('puts the previous target back when the new link cannot be created', () => {
    const base = scratch();
    const a = dir(base, 'account-a');
    const b = dir(base, 'account-b');
    const link = path.join(base, 'live');
    symlinkSync(a, link, 'junction');
    const plan = planPointer(link, b);

    // Fails for the new target, works for the restore — a policy that denies
    // the write, or a path the OS will not take.
    const outcome = applyPointer(plan, (target, at) => {
      if (path.resolve(target) === path.resolve(b)) throw new Error('EPERM: denied');
      symlinkSync(target, at, 'junction');
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('still points at');
    // A failed flip must cost nothing: the link points where it did before.
    expect(path.resolve(inspectPointer(link).target!)).toBe(path.resolve(a));
  });

  it('says so loudly when it cannot even put the old link back', () => {
    const base = scratch();
    const a = dir(base, 'account-a');
    const b = dir(base, 'account-b');
    const link = path.join(base, 'live');
    symlinkSync(a, link, 'junction');
    const plan = planPointer(link, b);

    const outcome = applyPointer(plan, () => {
      throw new Error('EPERM: denied');
    });

    expect(outcome.ok).toBe(false);
    // The one case that leaves the machine worse off has to name the way back.
    expect(outcome.message).toContain('does not exist right now');
    expect(outcome.message).toContain(a);
    expect(existsSync(link)).toBe(false);
  });

  it('refuses a blocked plan rather than acting on it', () => {
    const base = scratch();
    const standing = dir(base, 'live');
    writeFileSync(path.join(standing, 'someones-work.txt'), 'x');

    expect(applyPointer(planPointer(standing, dir(base, 'account-a'))).ok).toBe(false);
    expect(existsSync(path.join(standing, 'someones-work.txt'))).toBe(true);
  });
});
