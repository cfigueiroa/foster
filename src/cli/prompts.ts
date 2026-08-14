import { CANCEL, isCancel, type Choice, type Ui } from '../tui/ui.js';

/** Sentinel returned by a step the user backed out of, so callers can return to the menu. */
export const BACK = Symbol('back');
export type Maybe<T> = T | typeof BACK;

export type { Choice };

export function aborted<T>(value: T | symbol): value is symbol {
  return isCancel(value) || value === BACK || value === CANCEL;
}

/** The value carried by the "Back" entry; never leaves this module's callers. */
export const BACK_OPTION = '__back';

/**
 * A select that always answers in the same currency.
 *
 * Backing out used to be a string in the option list but a symbol in the return
 * type, so every caller had to remember to check for both. One that checked only
 * the symbol passed the literal "__back" downstream, where it was used as a
 * lookup key and crashed. Converting here means callers only ever see BACK.
 */
export async function selectOrBack(
  ui: Ui,
  message: string,
  options: Choice[],
  initialValue?: string,
): Promise<Maybe<string>> {
  const picked = await ui.select({
    message,
    options: [...options, { value: BACK_OPTION, label: 'Back' }],
    ...(initialValue === undefined ? {} : { initialValue }),
  });
  return isCancel(picked) || picked === BACK_OPTION ? BACK : picked;
}

export async function askText(
  ui: Ui,
  message: string,
  options: { initialValue?: string; placeholder?: string } = {},
): Promise<Maybe<string>> {
  const answer = await ui.text({ message, ...options });
  if (aborted(answer)) return BACK;
  // An empty submission resolves as undefined, not '' — the placeholder is
  // ghost text, not a default. The String() that once stood here turned that
  // into the word "undefined", which every caller's emptiness check then
  // waved through: an account really did get named that.
  return typeof answer === 'string' ? answer : '';
}

/**
 * Tick individual entries.
 *
 * `required: false` on purpose: selecting nothing is a legitimate way to change
 * your mind, and the caller reads an empty list as "never mind" rather than
 * leaving the user stuck on a prompt that will not let them out.
 */
export async function pickMany(
  ui: Ui,
  message: string,
  options: Choice[],
): Promise<Maybe<string[]>> {
  const picked = await ui.multiselect({ message, options, required: false });
  if (aborted(picked)) return BACK;
  return picked;
}
