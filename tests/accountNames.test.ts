import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger/log.js';
import { labelsOf, manualLabelsOf } from '../src/cli/names.js';

/**
 * An account had two names in the ledger and the screens read only one of them:
 * every `labels.get(uuid) ?? shortId(uuid)` printed eight hex digits for an
 * account whose e-mail was sitting right there, recorded by `whoami` or
 * `identify`. These are about the order between the two.
 */

const HERS = '11111111-1111-4111-8111-111111111111';
const HIS = '22222222-2222-4222-8222-222222222222';
const NOBODY = '33333333-3333-4333-8333-333333333333';

function ledger(): Ledger {
  return new Ledger(path.join(mkdtempSync(path.join(tmpdir(), 'foster-names-')), 'ledger.jsonl'));
}

describe('the name an account goes by', () => {
  it('uses the e-mail the API answered with when nobody has named the account', () => {
    const log = ledger();
    log.append({ kind: 'account_identity_seen', accountUuid: HERS, email: 'her@x.test' });

    expect(labelsOf(log).get(HERS)).toBe('her@x.test');
  });

  it('prefers a label a person chose over the e-mail', () => {
    const log = ledger();
    log.append({ kind: 'account_identity_seen', accountUuid: HERS, email: 'her@x.test' });
    log.append({ kind: 'account_labelled', accountUuid: HERS, label: 'Work' });

    expect(labelsOf(log).get(HERS)).toBe('Work');
  });

  it('falls back to the display name when the sighting carried no e-mail', () => {
    const log = ledger();
    log.append({ kind: 'account_identity_seen', accountUuid: HIS, name: 'Him' });

    expect(labelsOf(log).get(HIS)).toBe('Him');
  });

  it('names nothing it has never seen, so the caller can still fall back to the uuid', () => {
    expect(labelsOf(ledger()).get(NOBODY)).toBeUndefined();
  });

  it('keeps the chosen labels apart, for the JSON field that promises exactly those', () => {
    const log = ledger();
    log.append({ kind: 'account_identity_seen', accountUuid: HERS, email: 'her@x.test' });
    log.append({ kind: 'account_labelled', accountUuid: HIS, label: 'Work' });

    const manual = manualLabelsOf(log);
    expect(manual.get(HIS)).toBe('Work');
    expect(manual.get(HERS)).toBeUndefined();
  });
});
