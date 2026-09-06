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

/** A store with one card in the origin account and its copy in this one. */
function fixture(originTitle: string, copyTitle: string, sources: Sources = {}): Fixture {
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
    }),
  );
  writeFileSync(
    copyPath,
    JSON.stringify({
      sessionId: 'local_copy',
      title: copyTitle,
      ...(sources.copy ? { titleSource: sources.copy } : {}),
    }),
  );

  const ledger = new Ledger(path.join(root, 'ledger.jsonl'));
  return { store, ledger, originPath, copyPath };
}

/** The fostering the copy came from, as the ledger records it. */
function fostered(f: Fixture, originalTitle: string | undefined): void {
  f.ledger.append({
    kind: 'fostered',
    originSessionId: 'local_origin',
    origin: ORIGIN,
    target: HERE,
    copySessionId: 'local_copy',
    copyPath: f.copyPath,
    prefix: '',
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
