/**
 * Whether a `claude://` link looks like the shell ate half of it.
 *
 * The installer's shim is a batch file, and when PowerShell invokes a `.cmd` the
 * `cmd.exe` re-parses the line: an `&` inside an argument ends the argument,
 * quotes on the PowerShell side or not. foster then receives a string that is
 * valid, shorter, and wrong — and hands it over reporting success (#100).
 *
 * Measured:
 *
 * ```
 * > foster app link "claude://code/continue?session=last&source=desktop_action"
 * Handed to the installation at ...
 * 'source' is not recognized as an internal or external command
 * ```
 *
 * The first line is foster confirming delivery of `?session=last`, without the
 * `source` the app requires. The second is `cmd.exe` trying to run the rest as a
 * command. Nothing about that reads as "your link was cut in half".
 *
 * This cannot detect truncation in general — a cut string carries no evidence of
 * what was removed. What it can do is know the shapes the app itself uses, and
 * say so when a link arrives missing a parameter that shape always has. Every
 * rule here comes from a URL the app builds or accepts, not from a guess about
 * what a link "should" contain.
 */

export interface LinkComplaint {
  /** What is missing, in the words of the link itself. */
  missing: string;
  /** The whole sentence to show, ending in what to do instead. */
  message: string;
}

/** How to pass a link no shell can mangle — the answer every complaint ends with. */
const VIA_STDIN =
  'If your shell ate part of it — a `&` in a URL ends the argument when PowerShell calls a\n' +
  '.cmd — pass the link on stdin instead, which no shell can touch:\n' +
  '  <command that prints the url> | foster app link -';

/**
 * The rules, each tied to something the app does.
 *
 * `code/continue` and `code/needs-input` are the two routes the app builds for
 * OS entries (Spotlight, launcher actions, the dock menu). Measured on build
 * 1.46388.4: the router reads `source` before anything else, and a link without
 * it does nothing at all — so a missing `source` is not a style question.
 *
 * A sign-in callback carries a single-use `code`. One that arrives without it is
 * either truncated or already spent, and delivering it wastes the code.
 */
export function complainAboutLink(url: string): LinkComplaint | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined; // Not this function's business; deliverUrl rejects it.
  }

  const host = parsed.host.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
  const has = (name: string): boolean => (parsed.searchParams.get(name) ?? '') !== '';

  if (host === 'code' && (path === '/continue' || path === '/needs-input')) {
    if (!has('source')) {
      return {
        missing: 'source',
        message:
          `${url}\n\n` +
          'This link has no `source`, and the app ignores these routes without one — measured on\n' +
          'build 1.46388.4, where the router reads it before deciding anything. The app writes them\n' +
          'as `...&source=desktop_action`.\n\n' +
          VIA_STDIN,
      };
    }
  }

  // The callback the browser hands back after a sign-in. `app login` arms the
  // handler for exactly this, and the code is single-use.
  if (/(^|\/)(auth|callback|login|oauth)/.test(path) || host === 'auth' || host === 'login') {
    if (!has('code')) {
      return {
        missing: 'code',
        message:
          'This looks like a sign-in callback with no `code` in it. The code is single-use, and a\n' +
          'link that lost it cannot sign anything in — handing it over would spend the attempt for\n' +
          'nothing.\n\n' +
          VIA_STDIN,
      };
    }
  }

  return undefined;
}
