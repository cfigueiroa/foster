/**
 * Small helpers for handing PowerShell a script without any layer between
 * here and the interpreter getting a chance to reparse it.
 */

/**
 * Base64 (UTF-16LE) encoding for `powershell.exe` / `pwsh.exe
 * -EncodedCommand` — the documented input shape for that flag. A script
 * passed this way is never re-tokenized by anything between here and
 * PowerShell itself: not `wt`'s own command-line splitting (it treats `;` as
 * its own subcommand separator, measured to do so even inside a quoted argv
 * element — see `launch.ts`'s `buildPsCommand`), not `CreateProcess`'s
 * argv-to-command-line quoting, nothing. A `-Command "<script>"` argument is
 * still text, typed as one string, that something downstream can misparse;
 * `-EncodedCommand`'s payload is not text at all until PowerShell decodes it.
 */
export function encodePsCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Wraps a value in a single-quoted PowerShell string literal, doubling any
 * embedded single quote — the one escape a single-quoted string needs, and
 * the only one: unlike a double-quoted string, nothing inside it is
 * interpolated, expanded, or evaluated.
 */
export function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
