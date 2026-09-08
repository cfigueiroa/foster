import { describe, expect, it } from 'vitest';
import { complainAboutLink } from '../src/engine/linkShape.js';

/**
 * A link cut in half by the shell (#100).
 *
 * The shim the installer writes is a batch file, so `cmd.exe` re-parses the line
 * PowerShell hands it and an `&` inside an argument ends the argument. foster
 * receives a shorter, valid, wrong string and delivers it reporting success.
 *
 * Truncation cannot be detected in general — what was removed left no trace. So
 * every rule here is tied to a shape the app itself uses, and anything outside
 * those shapes is deliberately left alone rather than guessed at.
 */

describe('complainAboutLink', () => {
  it('catches an OS-entry route that lost its source', () => {
    // Measured on build 1.46388.4: the router reads `source` before deciding
    // anything, and without it the link does nothing at all.
    const complaint = complainAboutLink('claude://code/continue?session=last');

    expect(complaint?.missing).toBe('source');
    expect(complaint?.message).toContain('app link -');
  });

  it('says nothing when the route is whole', () => {
    expect(
      complainAboutLink('claude://code/continue?session=last&source=desktop_action'),
    ).toBeUndefined();
  });

  it('applies the same rule to needs-input', () => {
    expect(complainAboutLink('claude://code/needs-input')?.missing).toBe('source');
    expect(complainAboutLink('claude://code/needs-input?source=spotlight')).toBeUndefined();
  });

  it('catches a sign-in callback with no code, which would spend the attempt', () => {
    const complaint = complainAboutLink('claude://auth/callback?state=abc');

    expect(complaint?.missing).toBe('code');
    expect(complaint?.message).toContain('single-use');
  });

  it('leaves a sign-in callback that carries its code alone', () => {
    expect(complainAboutLink('claude://auth/callback?code=xyz&state=abc')).toBeUndefined();
  });

  it('treats an empty parameter as missing, not present', () => {
    // `?source=` is what a shell leaves behind about as often as it drops the
    // parameter entirely.
    expect(complainAboutLink('claude://code/continue?session=last&source=')?.missing).toBe(
      'source',
    );
  });

  it('says nothing about routes it has not measured', () => {
    // The point of the whole exercise is not inventing requirements: a rule that
    // does not come from something the app does would refuse working links.
    expect(complainAboutLink('claude://code/new')).toBeUndefined();
    expect(complainAboutLink('claude://something/else?a=1')).toBeUndefined();
  });

  it('leaves a string that is not a URL to the code that rejects it', () => {
    expect(complainAboutLink('not a url at all')).toBeUndefined();
  });
});
