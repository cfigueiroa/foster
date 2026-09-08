import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planTitleSync, applyTitleSync } from '../src/engine/titleSync.js';
import { Ledger } from '../src/ledger/log.js';
import { layoutFor } from '../src/domain/paths.js';
import type { AccountRef } from '../src/domain/types.js';

/**
 * A conversation renamed where it came from used to keep the old name in every
 * other account for ever (#17). These are about the one question that decides
 * whether the fix is a reconciliation or a trampling: whose title is on the copy
 * right now, and who put it there.
 */

const ORIGIN: AccountRef = {
  accountUuid: '00000000-0000-4000-8000-00000000000a',
  organizationUuid: '00000000-0000-4000-8000-0000000000a0',
};
const HERE: AccountRef = {
  accountUuid: '00000000-0000-4000-8000-00000000000b',
  organizationUuid: '00000000-0000-4000-8000-0000000000b0',
};

interface Fixture {
  store: ReturnType<typeof layoutFor>;
  ledger: Ledger;
  originPath: string;
  copyPath: string;
}

/** Who the cards say named them: 'auto' the app, 'user'/'tool' a person, absent unknown. */
interface Sources {
  origin?: string;
  copy?: string;
}

/** The names each card used to wear, newest first, as the app records them. */
interface Histories {
  origin?: string[];
  copy?: string[];
}

/** A store with one card in the origin account and its copy in this one. */
function fixture(
  originTitle: string,
  copyTitle: string,
  sources: Sources = {},
  histories: Histories = {},
): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'foster-sync-'));
  const store = layoutFor(root);
  const dir = (ref: AccountRef) =>
    path.join(root, 'claude-code-sessions', ref.accountUuid, ref.organizationUuid);
  mkdirSync(dir(ORIGIN), { recursive: true });
  mkdirSync(dir(HERE), { recursive: true });

  const originPath = path.join(dir(ORIGIN), 'local_origin.json');
  const copyPath = path.join(dir(HERE), 'local_copy.json');
  writeFileSync(
    originPath,
    JSON.stringify({
      sessionId: 'local_origin',
      title: originTitle,
      ...(sources.origin ? { titleSource: sources.origin } : {}),
      ...(histories.origin ? { previousTitles: histories.origin } : {}),
    }),
  );
  writeFileSync(
    copyPath,
    JSON.stringify({
      sessionId: 'local_copy',
      title: copyTitle,
      ...(sources.copy ? { titleSource: sources.copy } : {}),
      ...(histories.copy ? { previousTitles: histories.copy } : {}),
    }),
  );

  const ledger = new Ledger(path.join(root, 'ledger.jsonl'));
  return { store, ledger, originPath, copyPath };
}

/** The fostering the copy came from, as the ledger records it. */
function fostered(f: Fixture, originalTitle: string | undefined, prefix = ''): void {
  f.ledger.append({
    kind: 'fostered',
    originSessionId: 'local_origin',
    origin: ORIGIN,
    target: HERE,
    copySessionId: 'local_copy',
    copyPath: f.copyPath,
    prefix,
    ...(originalTitle === undefined ? {} : { originalTitle }),
  });
}

/** A title foster wrote on a card afterwards — the branch pass marking a row. */
function marked(f: Fixture, sessionId: string, from: string, to: string): void {
  f.ledger.append({
    kind: 'card_retitled',
    sessionId,
    target: sessionId === 'local_copy' ? HERE : ORIGIN,
    path: sessionId === 'local_copy' ? f.copyPath : f.originPath,
    from,
    to,
    native: false,
    as: 'stale',
  });
}

/** A title foster wrote to bring a copy into step — a write that adds no mark. */
function syncedBy(f: Fixture, from: string, to: string): void {
  f.ledger.append({
    kind: 'card_retitled',
    sessionId: 'local_copy',
    target: HERE,
    path: f.copyPath,
    from,
    to,
    native: false,
    as: 'synced',
  });
}

describe('planTitleSync', () => {
  it('brings a copy back into step when the original was renamed', () => {
    const f = fixture('The name it has now', 'The name it had then');
    fostered(f, 'The name it had then');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.to).toBe('The name it has now');
    expect(plan.skipped).toEqual([]);
  });

  it('leaves a copy alone once somebody has renamed it here', () => {
    const f = fixture('The name it has now', 'What I decided to call it');
    fostered(f, 'The name it had then');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([{ copySessionId: 'local_copy', reason: 'renamed-here' }]);
  });

  it('rewrites a copy the app named here, over a name a person chose at the origin', () => {
    // The reported case: renamed in the account it came from, then opened here,
    // where the app generated a title of its own. No baseline matches, and yet
    // nobody chose the name this row wears.
    const f = fixture('🚚 frota: repositório e release', 'Localização do comando frota', {
      origin: 'tool',
      copy: 'auto',
    });
    fostered(f, 'frota');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items[0]?.to).toBe('🚚 frota: repositório e release');
    expect(plan.items[0]?.because).toBe('app-named-here');
    expect(plan.skipped).toEqual([]);
  });

  it('reports a conflict, and settles nothing, when a person named each side', () => {
    const f = fixture('What they call it there', 'What I decided to call it', {
      origin: 'user',
      copy: 'user',
    });
    fostered(f, 'The name it had then');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        copySessionId: 'local_copy',
        reason: 'renamed-both',
        here: 'What I decided to call it',
        there: 'What they call it there',
      },
    ]);
  });

  it('says nothing about a copy that already agrees with its original', () => {
    // Both sides renamed to the same string, neither matching what foster wrote.
    // Measured on a real store: this was being printed as a conflict, and rows
    // like it were inflating the "renamed here" tally.
    const f = fixture('⭐ Orquestrador rioprev', '⭐ Orquestrador rioprev', {
      origin: 'user',
      copy: 'user',
    });
    fostered(f, 'Orquestrador de sessões e issues');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it('will not trade one app-generated name for another', () => {
    const f = fixture('What the app called it there', 'What the app called it here', {
      origin: 'auto',
      copy: 'auto',
    });
    fostered(f, 'The name it had then');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([{ copySessionId: 'local_copy', reason: 'renamed-here' }]);
  });

  it('puts the branch mark back when the app wrote over it', () => {
    const f = fixture('The name it has now', 'What the app called it', {
      origin: 'user',
      copy: 'auto',
    });
    fostered(f, 'The name it had then');
    marked(f, 'local_copy', 'The name it had then', '(stale, stopped 01/09) The name it had then');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items[0]?.to).toBe('(stale, stopped 01/09) The name it has now');
  });

  it('keeps the mark the branch pass put on the copy, in front of the new title', () => {
    const f = fixture('The name it has now', '(stale, stopped 01/09) The name it had then');
    fostered(f, 'The name it had then');
    marked(f, 'local_copy', 'The name it had then', '(stale, stopped 01/09) The name it had then');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items[0]?.to).toBe('(stale, stopped 01/09) The name it has now');
    expect(plan.items[0]?.mark).toBe('(stale, stopped 01/09) ');
  });

  /**
   * The copy was made from a card the branch pass had already marked, so the
   * mark is inside the title the ledger records the copy as having been made
   * with. Comparing against that title raw finds no mark, reads it as part of
   * the name, and rewrites the copy to the origin's clean title — the branch
   * pass then marks it again on the next sweep, and the two never settle (#79).
   */
  it('knows a mark that is inside the very title the copy was made with', () => {
    const MARK = '(stale, stopped 04/09 21:04) ';
    const f = fixture(`${MARK}A conversation`, `${MARK}A conversation`);
    fostered(f, `${MARK}A conversation`);
    marked(f, 'local_origin', 'A conversation', `${MARK}A conversation`);

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });

  it('leaves standing the mark the branch pass wrote back after a sync stripped it', () => {
    const MARK = '(stale, stopped 04/09 21:04) ';
    const f = fixture(`${MARK}A conversation`, `${MARK}A conversation`);
    fostered(f, `${MARK}A conversation`);
    marked(f, 'local_origin', 'A conversation', `${MARK}A conversation`);
    // The run that started the loop: the sync took the mark off, and the branch
    // pass of the next run put it back.
    syncedBy(f, `${MARK}A conversation`, 'A conversation');
    marked(f, 'local_copy', 'A conversation', `${MARK}A conversation`);

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });

  it("never carries the original's own mark across, so marks cannot stack", () => {
    const f = fixture('(stale, stopped 02/09) The name it has now', 'The name it had then');
    fostered(f, 'The name it had then');
    marked(f, 'local_origin', 'The name it has now', '(stale, stopped 02/09) The name it has now');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items[0]?.to).toBe('The name it has now');
  });

  it('will not rewrite a card whose mark it cannot tell from the title beneath it', () => {
    // Marked twice — stale on one run, diverged on the next, which #35 makes
    // ordinary. The second record's `from` already carries the first mark, so
    // subtracting that would leave nothing and the row would lose its mark.
    // This is the case a dry run against a real store caught.
    const f = fixture(
      'Recuperar chats antigos',
      '(outro ramo, seguiu 26/08 14:24) Recuperar chats antigos',
    );
    fostered(f, 'Something else entirely');
    marked(
      f,
      'local_copy',
      '(defasada, parou 26/08 14:24) Recuperar chats antigos',
      '(outro ramo, seguiu 26/08 14:24) Recuperar chats antigos',
    );

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([{ copySessionId: 'local_copy', reason: 'unknown-mark' }]);
  });

  it('keeps the mark through a second marking, when the title it was made with is still under it', () => {
    const f = fixture(
      'Recuperar chats antigos, renomeado',
      '(outro ramo, seguiu 26/08 14:24) Recuperar chats antigos',
    );
    fostered(f, 'Recuperar chats antigos');
    marked(
      f,
      'local_copy',
      '(defasada, parou 26/08 14:24) Recuperar chats antigos',
      '(outro ramo, seguiu 26/08 14:24) Recuperar chats antigos',
    );

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items[0]?.to).toBe(
      '(outro ramo, seguiu 26/08 14:24) Recuperar chats antigos, renomeado',
    );
  });

  it('never takes its own sync for a mark, however many times it is run', () => {
    // Measured on a real store: the origin was renamed with an emoji in front,
    // the first run copied that across, and every run after it read the emoji
    // as a branch mark and wrote it in front again — one more emoji per sweep,
    // with the run never once saying it had finished.
    const f = fixture('👁️ Validação de plist com plistlib', 'Validação de plist com plistlib');
    fostered(f, 'Validação de plist com plistlib');

    const first = planTitleSync(f.store, f.ledger, HERE);
    expect(first.items[0]?.to).toBe('👁️ Validação de plist com plistlib');
    applyTitleSync(first.items, { ledger: f.ledger });

    const second = planTitleSync(f.store, f.ledger, HERE);
    expect(second.items).toEqual([]);
    expect(second.skipped).toEqual([]);
  });

  it('carries the branch mark through a sync without stacking it', () => {
    const f = fixture('The name it has now', '(stale, stopped 01/09) The name it had then');
    fostered(f, 'The name it had then');
    marked(f, 'local_copy', 'The name it had then', '(stale, stopped 01/09) The name it had then');

    const first = planTitleSync(f.store, f.ledger, HERE);
    expect(first.items[0]?.to).toBe('(stale, stopped 01/09) The name it has now');
    applyTitleSync(first.items, { ledger: f.ledger });

    const second = planTitleSync(f.store, f.ledger, HERE);
    expect(second.items).toEqual([]);
  });

  it('does not invent a mark from a sync when the copy was never marked', () => {
    const f = fixture('🚚 The name it has now', '🚚 The name it had then');
    fostered(f, 'The name it had then');
    syncedBy(f, 'The name it had then', '🚚 The name it had then');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items[0]?.to).toBe('🚚 The name it has now');
    expect(plan.items[0]?.mark).toBeUndefined();
  });

  it('takes the name the origin moved on to, when its history proves the copy is behind', () => {
    // Neither card carries a timestamp for its title, so "which rename is
    // newer" cannot be dated. It can still be ordered: the origin's history
    // holds the very name the copy is wearing, so the origin has been through
    // it and gone on. Measured on a real store, this is exactly the shape of
    // the one conflict that was not foster's own mark.
    const f = fixture(
      '🚀 Contrato social OAB',
      '⭐ Contrato social OAB',
      { origin: 'tool', copy: 'tool' },
      { origin: ['⭐ Contrato social OAB', 'Contrato social OAB'], copy: ['Contrato social OAB'] },
    );
    fostered(f, 'Contrato social OAB');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items[0]?.to).toBe('🚀 Contrato social OAB');
    expect(plan.items[0]?.because).toBe('renamed-later-there');
    expect(plan.skipped).toEqual([]);
  });

  it('leaves the copy alone when the copy is the side renamed later', () => {
    const f = fixture(
      '⭐ Contrato social OAB',
      '🚀 Contrato social OAB',
      { origin: 'tool', copy: 'tool' },
      { origin: ['Contrato social OAB'], copy: ['⭐ Contrato social OAB', 'Contrato social OAB'] },
    );
    fostered(f, 'Contrato social OAB');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([{ copySessionId: 'local_copy', reason: 'renamed-here' }]);
  });

  it('still reports a conflict when each history has been through the other name', () => {
    // Renamed past each other: both readings are available and they disagree,
    // which is no better than having none.
    const f = fixture(
      '⭐ Contrato social OAB',
      '🚀 Contrato social OAB',
      { origin: 'user', copy: 'user' },
      { origin: ['🚀 Contrato social OAB'], copy: ['⭐ Contrato social OAB'] },
    );
    fostered(f, 'Contrato social OAB');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe('renamed-both');
  });

  it('knows its own mark on a card the ledger does not name, and calls it no rename', () => {
    // A card foster writes keeps whatever `titleSource` it already had, so its
    // own mark reads as a name a person chose. Measured on a real store: four
    // of the five "named on both sides" conflicts were this, not a rename.
    const f = fixture(
      'Configuração de Macs M5 Max',
      '(defasada, parou 02/09 08:24) Configuração de Macs M5 Max',
      { origin: 'tool', copy: 'tool' },
    );
    fostered(f, 'Configuração de Macs M5 Max');
    // The words are in the log, from a mark made on some other card entirely.
    marked(f, 'local_origin', 'Outra conversa', '(defasada, parou 01/09 18:10) Outra conversa');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it("takes the origin's own mark off even when the ledger does not name that write", () => {
    // Both halves of one fork, each marked on its own sweep. The copy's mark is
    // kept and the origin's is not carried over — otherwise the two stack, which
    // is what a dry run against a real store produced: four rows planned to be
    // rewritten with the same mark twice over.
    const f = fixture(
      '(defasada, parou 01/09 18:10) Configuração de Macs M5 Max',
      '(defasada, parou 02/09 08:24) Configuração de Macs M5 Max',
    );
    fostered(f, 'Configuração de Macs M5 Max');
    marked(
      f,
      'local_copy',
      'Configuração de Macs M5 Max',
      '(defasada, parou 02/09 08:24) Configuração de Macs M5 Max',
    );

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });

  it("reads a mark in this run's own words, before the ledger holds any", () => {
    // A wording a sweep is told to use for the first time — or a mark applied by
    // hand in that same shape — has no `card_retitled` behind it yet. Read
    // against the ledger alone it is a name somebody chose, which is how a mark
    // written by hand turned into a reported conflict on a real store.
    const f = fixture(
      'Base Histórica de Proventos: plano-mestre e fases',
      '(continuou, até 28/08 19:16) Base Histórica de Proventos: plano-mestre e fases',
      { origin: 'tool', copy: 'tool' },
    );
    fostered(f, 'Base Histórica de Proventos: plano-mestre e fases');

    const blind = planTitleSync(f.store, f.ledger, HERE);
    expect(blind.skipped[0]?.reason).toBe('renamed-both');

    const told = planTitleSync(f.store, f.ledger, HERE, undefined, ['(continuou, até {when}) ']);
    expect(told.items).toEqual([]);
    expect(told.skipped).toEqual([]);
  });

  it('knows its own copy marker, which carries no moment for a template to be made of', () => {
    // The `↪ ` of the era before 0.37.0. `templatesSeen` will not derive a
    // template from it — no stamp — so `stripMarks` cannot take it off, and two
    // rows on the measured store were reported as named on both sides over a
    // prefix foster had written itself.
    const f = fixture('The name it has now', '↪ The name it had then', {
      origin: 'tool',
      copy: 'tool',
    });
    fostered(f, 'The name it had then', '↪ ');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items[0]?.to).toBe('↪ The name it has now');
    expect(plan.items[0]?.mark).toBe('↪ ');
    expect(plan.skipped).toEqual([]);
  });

  it('takes the copy marker and a branch mark off together', () => {
    const f = fixture('The name it has now', '(stale, stopped 01/09 09:00) ↪ The name it had then');
    fostered(f, 'The name it had then', '↪ ');
    marked(f, 'local_origin', 'Outra conversa', '(stale, stopped 02/09 10:00) Outra conversa');

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items[0]?.to).toBe('(stale, stopped 01/09 09:00) ↪ The name it has now');
    expect(plan.items[0]?.mark).toBe('(stale, stopped 01/09 09:00) ↪ ');
  });

  it('writes a name onto a copy of a conversation nobody had titled', () => {
    const f = fixture('A name at last', '');
    fostered(f, undefined);

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items[0]?.to).toBe('A name at last');
  });

  it('will not guess when there is no baseline and the copy already says something', () => {
    const f = fixture('The name it has now', 'Something somebody typed');
    fostered(f, undefined);

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.items).toEqual([]);
    expect(plan.skipped).toEqual([{ copySessionId: 'local_copy', reason: 'no-baseline' }]);
  });

  it('plans nothing when the two already agree', () => {
    const f = fixture('The same name', 'The same name');
    fostered(f, 'The same name');

    expect(planTitleSync(f.store, f.ledger, HERE).items).toEqual([]);
  });

  it('says so when the card it was copied from is gone', () => {
    const f = fixture('anything', 'anything else');
    f.ledger.append({
      kind: 'fostered',
      originSessionId: 'local_missing',
      origin: ORIGIN,
      target: HERE,
      copySessionId: 'local_copy',
      copyPath: f.copyPath,
      prefix: '',
      originalTitle: 'anything else',
    });

    const plan = planTitleSync(f.store, f.ledger, HERE);

    expect(plan.skipped).toEqual([{ copySessionId: 'local_copy', reason: 'origin-gone' }]);
  });

  it('ignores copies that went to another account', () => {
    const f = fixture('The name it has now', 'The name it had then');
    fostered(f, 'The name it had then');

    expect(planTitleSync(f.store, f.ledger, ORIGIN).items).toEqual([]);
  });
});

describe('applyTitleSync', () => {
  it('writes the title and records it as a sync, leaving the archived flag alone', () => {
    const f = fixture('The name it has now', 'The name it had then');
    fostered(f, 'The name it had then');

    const outcomes = applyTitleSync(planTitleSync(f.store, f.ledger, HERE).items, {
      ledger: f.ledger,
    });

    expect(outcomes.map((o) => o.status)).toEqual(['retitled']);
    const written = JSON.parse(readFileSync(f.copyPath, 'utf8')) as Record<string, unknown>;
    expect(written.title).toBe('The name it has now');
    expect(written.isArchived).toBeUndefined();

    const recorded = f.ledger
      .read()
      .filter((event) => event.kind === 'card_retitled')
      .at(-1);
    expect(recorded).toMatchObject({ as: 'synced', to: 'The name it has now' });
  });

  it('writes nothing on a dry run', () => {
    const f = fixture('The name it has now', 'The name it had then');
    fostered(f, 'The name it had then');

    applyTitleSync(planTitleSync(f.store, f.ledger, HERE).items, {
      ledger: f.ledger,
      dryRun: true,
    });

    const still = JSON.parse(readFileSync(f.copyPath, 'utf8')) as Record<string, unknown>;
    expect(still.title).toBe('The name it had then');
  });
});
