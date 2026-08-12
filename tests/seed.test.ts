import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applySeed, planSeed } from '../src/engine/seed.js';

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'foster-seed-'));
}

/** A config directory with one of everything a real client accumulates. */
function source(): string {
  const dir = scratch();
  writeFileSync(path.join(dir, 'settings.json'), '{"model":"opus"}');
  writeFileSync(path.join(dir, 'settings.local.json'), '{"local":true}');
  writeFileSync(path.join(dir, 'CLAUDE.md'), '# house rules');
  writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"secret"}}');
  writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'someone@example.test' } }),
  );

  mkdirSync(path.join(dir, 'agents'));
  writeFileSync(path.join(dir, 'agents', 'reviewer.md'), 'review things');
  mkdirSync(path.join(dir, 'skills', 'pdf'), { recursive: true });
  writeFileSync(path.join(dir, 'skills', 'pdf', 'SKILL.md'), 'read pdfs');
  mkdirSync(path.join(dir, 'projects', 'work'), { recursive: true });
  writeFileSync(path.join(dir, 'projects', 'work', 'a.jsonl'), '{"private":"conversation"}');

  return dir;
}

describe('planSeed', () => {
  it('lists what it would copy and what it would link', () => {
    const plan = planSeed(path.join(scratch(), 'new'), source());

    expect(plan.copies).toEqual(['settings.json', 'settings.local.json', 'CLAUDE.md', 'agents']);
    expect(plan.links).toEqual(['skills']);
  });

  it('refuses a target that already holds a credential', () => {
    const target = scratch();
    writeFileSync(path.join(target, '.credentials.json'), '{}');

    expect(planSeed(target, source()).blockers[0]).toContain('that is a client');
  });

  it('refuses a target that has other things in it', () => {
    const target = scratch();
    writeFileSync(path.join(target, 'notes.md'), 'mine');

    expect(planSeed(target, source()).blockers[0]).toContain('not empty');
  });

  it('refuses to seed a directory from itself', () => {
    const dir = source();
    expect(planSeed(dir, dir).blockers[0]).toContain('same directory');
  });
});

describe('applySeed', () => {
  it('copies the settings and instructions', () => {
    const target = path.join(scratch(), 'new');
    applySeed(planSeed(target, source()));

    expect(readFileSync(path.join(target, 'settings.json'), 'utf8')).toBe('{"model":"opus"}');
    expect(readFileSync(path.join(target, 'CLAUDE.md'), 'utf8')).toBe('# house rules');
    expect(readFileSync(path.join(target, 'agents', 'reviewer.md'), 'utf8')).toBe('review things');
  });

  it('links skills instead of copying them, so there is one warehouse', () => {
    // The measured failure this exists for: a new directory born without skills
    // runs sessions that quietly have fewer capabilities, with nothing saying so.
    // A copy would fix that once and start drifting the next day.
    const from = source();
    const target = path.join(scratch(), 'new');
    applySeed(planSeed(target, from));

    expect(lstatSync(path.join(target, 'skills')).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(target, 'skills', 'pdf', 'SKILL.md'), 'utf8')).toBe('read pdfs');

    // One warehouse means a skill added later is visible from the new client too.
    writeFileSync(path.join(from, 'skills', 'later.md'), 'added afterwards');
    expect(existsSync(path.join(target, 'skills', 'later.md'))).toBe(true);
  });

  it('never copies the credential', () => {
    const target = path.join(scratch(), 'new');
    applySeed(planSeed(target, source()));

    // Two directories holding one account's credential is the exact state the
    // vault's one-live-copy rule exists to prevent.
    expect(existsSync(path.join(target, '.credentials.json'))).toBe(false);
  });

  it('never copies the conversation history', () => {
    const target = path.join(scratch(), 'new');
    applySeed(planSeed(target, source()));

    expect(existsSync(path.join(target, 'projects'))).toBe(false);
  });

  it('never copies the cached profile, so the new client is nobody until a login', () => {
    // Copying `.claude.json` would make `foster clients` report the seeded-from
    // account's identity for a directory nobody has signed into.
    const target = path.join(scratch(), 'new');
    applySeed(planSeed(target, source()));

    expect(existsSync(path.join(target, '.claude.json'))).toBe(false);
  });

  it('says the new client is signed out, because that is the next step', () => {
    const outcome = applySeed(planSeed(path.join(scratch(), 'new'), source()));

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('signed out');
  });

  it('writes nothing for a blocked plan', () => {
    const target = scratch();
    writeFileSync(path.join(target, 'notes.md'), 'mine');

    expect(applySeed(planSeed(target, source())).ok).toBe(false);
    expect(existsSync(path.join(target, 'settings.json'))).toBe(false);
  });
});
