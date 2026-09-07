import { layoutFor, sessionPath } from '../domain/paths.js';
import { stripMarks, templatesSeen } from '../domain/stale.js';
import type { AccountRef, CodeSessionData, StoreLayout } from '../domain/types.js';
import type { Ledger } from '../ledger/log.js';
import { listActive, project, type LedgerState } from '../ledger/project.js';
import type { ActiveFostering, RetitledCard } from '../ledger/types.js';
import { readSessionFile } from '../store/sessionFile.js';
import { retitleCards, type RetitleOutcome } from './retitle.js';

/**
 * Bring a copy's title back into step with the original's.
 *
 * A copy carries the title of the instant it was made, and every later sweep
 * sees it as already fostered and walks past. So a conversation renamed in the
 * account it came from keeps the old name in every other account for ever
 * (#17) — the sidebar reads as if the work were missing, when only its name is.
 * Nothing about the mechanics was in the way: `retitle.ts` has rewritten titles
 * with the app open since 0.37.0. The step was missing, not the ability.
 *
 * Three decisions hold this together, and all three come from the ledger rather
 * than from reading strings.
 *
 * **Whose title wins.** A copy still wearing the last title foster itself wrote
 * is rewritten: that is `card_retitled.to` when foster has marked the card
 * since, and the fostering's `originalTitle` otherwise. A copy the user renamed
 * by hand matches neither and is left alone — measured on a real store, 875 of
 * 911 copies still matched, 9 wore a mark, and the single hand-renamed one was
 * exactly the row that must not be trampled.
 *
 * That test alone is too narrow, though, and the gap is not rare. Open a copy in
 * this account and the app generates a title for it, which matches no baseline —
 * so a conversation renamed where it came from stayed out of step for ever, and
 * a sweep reported it as "renamed here" when nobody had renamed anything. The
 * card records who named it (`titleSource`, see `namerOf`), so the second rule
 * is authorship: a name a person chose beats a name the app generated, and a
 * name chosen on both sides is settled only where it can be proved.
 *
 * **Which rename is newer**, where both were chosen. No clock answers it: there
 * is no `titleUpdatedAt`, and `lastActivityAt` moves when a conversation is
 * merely opened. `previousTitles` does — the names a card used to wear. A side
 * whose history already holds the name the other side is wearing has been
 * through it and gone on, which orders the two without dating either. Both
 * histories through the other's name, or neither, is a real tie and stays a
 * reported conflict.
 *
 * **Marks are kept, and never copied.** The mark a branch wears is not part of
 * its name, so it survives the rewrite; and a mark the *origin* happens to wear
 * is not carried over, or the two would stack. The mark comes from `markedTo`,
 * the title left by the last write that could make one — never from subtracting
 * anything out of the latest title, which reads a sync's own work as a mark and
 * writes it in front again on the next run. Where the ledger names no such write
 * — a mark made under another card's id, or reworded since — the words of #35
 * answer instead: every template this log proves foster used, plus the ones this
 * run was told to write, which are not in the log yet.
 *
 * **Cards are paired by card, never by conversation.** A title lives on a card;
 * one conversation becomes a card per account and another per branch. The ledger
 * already records which card was copied from which, and on the same store 85
 * fosterings carry no `cliSessionId` at all — pairing on the transcript would
 * silently drop them.
 *
 * Only the title crosses. `card_retitled` carries the archived flag too, and
 * following that as well would make this state sync: whether a branch belongs in
 * the archived view is the sweep's own decision, taken per branch, and not this
 * pass's to overrule.
 */

export interface TitleSyncItem {
  /** The copy to rewrite. */
  path: string;
  copySessionId: string;
  /** The account directory the copy sits in. */
  target: AccountRef;
  /** What the copy is called now. */
  from: string;
  /** What it will be called: the original's own title, behind any mark it wears. */
  to: string;
  /** The mark being preserved, when the copy wears one. */
  mark?: string;
  /**
   * Why this copy may be rewritten: `foster-baseline` — it still wears the last
   * title foster wrote, so nobody has chosen its name since; `app-named-here` —
   * the app auto-titled it in this account, over a name a person chose in the
   * account it came from; `renamed-later-there` — a person named both sides, and
   * the origin's own history proves it has been through the name this copy wears
   * and moved past it.
   */
  because: 'foster-baseline' | 'app-named-here' | 'renamed-later-there';
}

export interface TitleSyncSkipped {
  copySessionId: string;
  /**
   * `renamed-here` — the copy no longer says what foster last wrote, and nothing
   * proves the app put that name there, or the copy is the side renamed later;
   * `renamed-both` — a person named the card on each side, the two disagree, and
   * neither history says which name came last; `no-baseline` — nothing records
   * what foster wrote and the copy is not blank, so there is nothing to compare
   * against; `unknown-mark` — foster marked this card but the mark cannot be told
   * from the title beneath it; `origin-gone` — the card it was copied from can no
   * longer be read.
   */
  reason: 'renamed-here' | 'renamed-both' | 'no-baseline' | 'unknown-mark' | 'origin-gone';
  /** For `renamed-both`, the two names in play — the run lists them to be settled by hand. */
  here?: string;
  there?: string;
}

export interface PlanTitleSyncResult {
  items: TitleSyncItem[];
  skipped: TitleSyncSkipped[];
}

/**
 * What a copy's title is compared against: the last title foster wrote on it,
 * and the mark that title carries.
 *
 * `card_retitled` wins over the fostering's `originalTitle` because it is later
 * — the branch pass may have marked this very card since it was made.
 *
 * The mark is derived against the title the copy was *made* with, never against
 * `card_retitled.from`. A card marked twice — stale on one run, then diverged on
 * the next, which #35 makes ordinary — has a `from` that already carries the
 * earlier mark, and subtracting that leaves nothing. Measured on a real store,
 * that is exactly what happened: a row wearing "(outro ramo, seguiu 26/08 14:24)"
 * was planned to lose it. When neither reading lands on a mark this can prove,
 * the copy is left alone rather than rewritten with a guess.
 */
function baselineOf(
  fostering: ActiveFostering,
  retitled: RetitledCard | undefined,
  here: string,
  templates: readonly string[],
): { title: string; mark: string } | 'unknown-mark' | undefined {
  // The copy wears a mark of its own over the very title foster last wrote:
  // the words of the mark were changed — by hand, or by a run told a different
  // `--branch-prefix` — while the conversation's own name stayed put. #35's
  // rule is that a mark is recognised by the moment it carries and not by the
  // words that wrote it; the same has to hold here, or every rewording reads as
  // a rename and is reported as a conflict for ever. The mark that stays is the
  // one on the card, never the one in the log: it is the later of the two.
  const wearing = (title: string): string =>
    title.slice(0, title.length - stripMarks(title, templates).length);
  const reworded = (was: string): { title: string; mark: string } | undefined => {
    const mark = wearing(here);
    if (!mark) return undefined;
    return stripMarks(here, templates) === stripMarks(was, templates)
      ? { title: here, mark }
      : undefined;
  };

  if (retitled) {
    // The mark is read off the last write that could have made one, never off
    // the latest title. A sync's `to` is `mark + whatever the origin is called
    // now`, so subtracting the title this copy was made with lands on the
    // origin's own new prefix and calls it a mark — which the next sync then
    // writes in front all over again. Nothing marked means no mark, whatever
    // the syncs since have made the title look like.
    if (retitled.markedTo === undefined) {
      return reworded(retitled.to) ?? { title: retitled.to, mark: '' };
    }
    const made = fostering.originalTitle;
    if (made !== undefined && retitled.markedTo.endsWith(made)) {
      const mark = retitled.markedTo.slice(0, retitled.markedTo.length - made.length);
      return reworded(retitled.to) ?? { title: retitled.to, mark };
    }
    return reworded(retitled.to) ?? 'unknown-mark';
  }
  const made = fostering.originalTitle;
  if (made === undefined) return undefined;
  // A mark this card wears from before the ledger carried one — written under
  // another card's id, or by a run whose entry the fold has since dropped. The
  // templates come from the ledger too (#35), so this still reads foster's own
  // writes rather than guessing at a prefix: a mark made from words the log
  // proves foster used, sitting on exactly the title this copy was made with.
  // Measured on a real store, this is what four of the five "named on both
  // sides" conflicts were — foster's own mark, reported as somebody's rename
  // because a card foster writes keeps whatever `titleSource` it already had.
  // A mark is an anchored prefix, so what `stripMarks` took off is exactly the
  // front of the title — no need to go looking for the seam a second time.
  //
  // Foster's own copy marker comes off in the same pass, from the fostering's
  // record of it rather than from the words: the `↪ ` of the era before 0.37.0
  // carries no moment, so no template is ever derived from it and `stripMarks`
  // leaves it standing. Two rows on the measured store wore one, and both were
  // reported as named on both sides over a prefix foster wrote itself.
  const clean = stripMarks(here, templates);
  const marker = fostering.prefix ?? '';
  const beneath = marker && clean.startsWith(marker) ? clean.slice(marker.length) : clean;
  if (here !== made && beneath === made) {
    return { title: here, mark: here.slice(0, here.length - made.length) };
  }
  return { title: made, mark: '' };
}

/**
 * Which side was renamed later, when a person named both — or nothing, when
 * that cannot be told.
 *
 * No clock can answer this. The card carries no `titleUpdatedAt`, and
 * `lastActivityAt` moves when a conversation is merely opened. What the card
 * does carry is `previousTitles`, the names it used to wear: a side whose
 * history already holds the name the *other* side is wearing has been through
 * that name and moved on, which orders the two without dating either. Measured
 * on a real store: the origin's history held `⭐ Contrato social OAB` while the
 * copy was still wearing it and the origin had gone on to `🚀`.
 *
 * Both histories holding the other's name means the two were renamed past each
 * other and neither reading is safe; neither holding it means there is nothing
 * to go on. Both are genuine ties, and a tie is still the user's to settle.
 */
function newerSide(
  here: string,
  there: string,
  copy: CodeSessionData,
  origin: CodeSessionData,
): 'here' | 'there' | undefined {
  const movedOnThere = (origin.previousTitles ?? []).includes(here);
  const movedOnHere = (copy.previousTitles ?? []).includes(there);
  if (movedOnThere === movedOnHere) return undefined;
  return movedOnThere ? 'there' : 'here';
}

/**
 * Who chose the name a card wears now, as the card itself records it.
 *
 * The app stamps `titleSource` on every write: `auto` when it generated the name
 * itself, `user` when somebody renamed the row in the sidebar, `tool` when
 * `set_session_title` wrote it — an agent, but always at a person's request, so
 * both count as chosen. Anything else, the field missing included, is `unknown`:
 * copies foster made before the field existed carry nothing, and 217 of 955
 * cards on the measured store are exactly that.
 *
 * There is no record of *when* a title changed — no `titleUpdatedAt`, and
 * `lastActivityAt` moves when a conversation is merely opened — so "keep
 * whichever rename is newer" cannot be answered at all. Authorship can, and it
 * settles the case that matters: a name a person chose beats a name the app
 * generated, whichever side each is on.
 */
type Namer = 'person' | 'app' | 'unknown';

function namerOf(card: { titleSource?: string }): Namer {
  switch (card.titleSource) {
    case 'user':
    case 'tool':
      return 'person';
    case 'auto':
      return 'app';
    default:
      return 'unknown';
  }
}

/**
 * The original's title with any mark of its own taken back off.
 *
 * The ledger answers first, and exactly: a card still wearing the title one of
 * foster's own writes left is worth what that write says it was worth before it.
 * Failing that — a mark made under another card's id, or by a run whose entry
 * the fold has since dropped — the words are still the ledger's own (#35), so a
 * mark made from a template this log proves foster used comes off too. Both
 * matter for the same reason: whatever stays on here is carried across to the
 * copy, in front of the mark the copy already wears, and the two stack.
 */
function originTitle(
  card: { title?: string },
  retitled: RetitledCard | undefined,
  templates: readonly string[],
): string {
  const title = card.title ?? '';
  // `from` is the title foster first saw, which is not always a clean one: a
  // card the app forked from a marked row was already wearing that mark before
  // foster ever wrote to it. So both readings go through the templates.
  return stripMarks(retitled && title === retitled.to ? retitled.from : title, templates);
}

function storeFor(fostering: ActiveFostering, store: StoreLayout): StoreLayout {
  return fostering.originStore ? layoutFor(fostering.originStore) : store;
}

/**
 * Every copy in one account whose original is called something else now.
 *
 * Read-only: it opens the cards on both sides and writes nothing.
 */
export function planTitleSync(
  store: StoreLayout,
  ledger: Ledger,
  target: AccountRef,
  state: LedgerState = project(ledger.read()),
  runTemplates: readonly string[] = [],
): PlanTitleSyncResult {
  const items: TitleSyncItem[] = [];
  const skipped: TitleSyncSkipped[] = [];
  // The words every mark this ledger proves foster wrote was made from — how a
  // mark left on a card before the ledger carried one is recognised, whatever
  // language the run that wrote it was speaking (#35).
  //
  // The run's own marks come first, and they are not in the log yet: a `{when}`
  // this sweep was told to write, or one written by hand in the same shape, has
  // no `card_retitled` behind it. Without them a row wearing this run's own
  // wording reads as a name somebody chose, which is how a mark applied by hand
  // turned into a reported conflict. `branchCards` has always mixed the two;
  // this pass was reading the ledger alone.
  const templates = [...new Set([...runTemplates, ...templatesSeen(ledger.read())])].filter(
    (template) => template !== '',
  );

  for (const fostering of listActive(state)) {
    if (
      fostering.target.accountUuid !== target.accountUuid ||
      fostering.target.organizationUuid !== target.organizationUuid
    ) {
      continue;
    }

    const copy = readSessionFile(fostering.copyPath);
    if (!copy) continue;

    const origin = readSessionFile(
      sessionPath(storeFor(fostering, store), fostering.origin, fostering.originSessionId),
    );
    if (!origin) {
      skipped.push({ copySessionId: fostering.copySessionId, reason: 'origin-gone' });
      continue;
    }

    const here = copy.title ?? '';
    const found = baselineOf(
      fostering,
      state.retitled.get(fostering.copySessionId),
      here,
      templates,
    );
    if (found === 'unknown-mark') {
      skipped.push({ copySessionId: fostering.copySessionId, reason: 'unknown-mark' });
      continue;
    }
    const baseline = found;

    const there = originTitle(origin, state.retitled.get(fostering.originSessionId), templates);
    // The mark goes back on. An app-generated title replaces whatever the branch
    // pass had written, mark included, and the verdict that mark records — which
    // branch stopped, which went on — is the sweep's, not the app's to drop.
    const mark = baseline?.mark ?? '';
    const to = mark + there;

    // Already in step, so there is nothing to decide and nothing to report — no
    // matter which side is out of line with the baseline, or who named either.
    // Asked before authorship rather than after: a dry run against a real store
    // printed a "conflict" whose two names were the same string, and the
    // "renamed here" tally counted rows that already agreed.
    if (to === here) continue;

    let because: TitleSyncItem['because'] = 'foster-baseline';

    // A copy of a conversation nobody had named is the one case with nothing to
    // compare and nothing to lose: it still says nothing, so a name arriving now
    // overwrites no decision. 253 of 8357 fosterings on the measured store are
    // exactly this.
    if (!baseline) {
      if (here !== '') {
        skipped.push({ copySessionId: fostering.copySessionId, reason: 'no-baseline' });
        continue;
      }
    } else if (here !== baseline.title) {
      // The copy says something foster did not write. Until authorship was read
      // that ended the matter, and it cost the case this was reported for: a
      // conversation renamed in the account it came from, then opened here,
      // where the app generated a name of its own over the copy. Nobody chose
      // that name, and the row it left behind is the one the sidebar cannot be
      // searched by.
      if (namerOf(copy) !== 'app' || namerOf(origin) !== 'person') {
        // Both sides chosen and disagreeing is the one case authorship cannot
        // settle — but it is not always a tie. Whichever card has already worn
        // the other's current name has been through it and moved on, so the
        // later rename is knowable without a clock; only when neither history
        // says so is this reported for the user to settle by hand.
        const bothChosen = namerOf(copy) === 'person' && namerOf(origin) === 'person';
        const newer = bothChosen
          ? newerSide(here.slice(mark.length), there, copy, origin)
          : undefined;
        if (newer !== 'there') {
          skipped.push({
            copySessionId: fostering.copySessionId,
            ...(bothChosen && newer === undefined
              ? { reason: 'renamed-both' as const, here, there }
              : { reason: 'renamed-here' as const }),
          });
          continue;
        }
        because = 'renamed-later-there';
      } else {
        because = 'app-named-here';
      }
    }

    items.push({
      path: fostering.copyPath,
      copySessionId: fostering.copySessionId,
      target: fostering.target,
      from: here,
      to,
      ...(mark ? { mark } : {}),
      because,
    });
  }

  return { items, skipped };
}

export interface ApplyTitleSyncOptions {
  ledger: Ledger;
  dryRun?: boolean;
}

/**
 * Write the plan. A copy is never native, so this never touches a card the app
 * made — and, like every other title write, it shows only at the next restart.
 */
export function applyTitleSync(
  items: TitleSyncItem[],
  options: ApplyTitleSyncOptions,
): RetitleOutcome[] {
  return retitleCards(
    items.map((item) => ({
      path: item.path,
      target: item.target,
      native: false,
      title: item.to,
      as: 'synced' as const,
    })),
    { ledger: options.ledger, ...(options.dryRun ? { dryRun: true } : {}) },
  );
}
