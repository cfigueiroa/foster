import { describe, expect, it } from 'vitest';
import { encodePsCommand, psSingleQuote } from '../src/util/powershell.js';

describe('psSingleQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(psSingleQuote('hello')).toBe("'hello'");
  });

  it('doubles an embedded single quote, the one escape a PS literal needs', () => {
    expect(psSingleQuote("o'brien")).toBe("'o''brien'");
  });

  it('leaves characters PowerShell would otherwise expand untouched, since none of this is ever evaluated', () => {
    expect(psSingleQuote('$(calc.exe) `whoami` "hi"; Remove-Item')).toBe(
      '\'$(calc.exe) `whoami` "hi"; Remove-Item\'',
    );
  });
});

describe('encodePsCommand', () => {
  it('round-trips through UTF-16LE base64, the shape -EncodedCommand expects', () => {
    const script = "Get-ChildItem Env:CLAUDE* | Remove-Item; Write-Output 'ok'";
    const encoded = encodePsCommand(script);

    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(script);
  });

  it('produces a payload with no `;`, quote, or whitespace for a `;`-joined script', () => {
    // The exact fact `launch.ts` relies on: `wt` splits its own command line
    // on a literal `;`, even inside a quoted argv element, so the encoded
    // form must not carry one for `wt` to ever see.
    const script = "cleanup; $env:CLAUDE_CONFIG_DIR='D:\\Claude-Work'; claude '--resume' 'abc'";
    const encoded = encodePsCommand(script);

    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(encoded).not.toMatch(/[;"'\s]/);
  });

  it('handles non-ASCII content the same way, since UTF-16LE carries it without a code page', () => {
    const script = "$env:CLAUDE_CONFIG_DIR='D:\\Claude-café'";
    const encoded = encodePsCommand(script);

    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(script);
  });
});
