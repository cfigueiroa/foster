import { CANCEL, isCancel, type Choice, type HomeRequest, type Ui } from './ui.js';
import type { ThemeName } from './theme.js';

/**
 * The test double for {@link Ui}: the same scripted-answer queue the clack
 * mock used to be. A flow that asked "which account?" still consumes one
 * answer; it does not have to type `/` and arrows.
 */
export class ScriptedUi implements Ui {
  readonly selects: Array<{ message: string; options: Choice[] }> = [];
  readonly notes: Array<{ message: string; title?: string }> = [];
  readonly log = {
    info: (message: string) => {
      this.info.push(message);
    },
    warn: (message: string) => {
      this.warnings.push(message);
    },
    error: (message: string) => {
      this.errors.push(message);
    },
    success: (message: string) => {
      this.successes.push(message);
    },
    message: (message: string) => {
      this.messages.push(message);
    },
  };
  readonly info: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  readonly successes: string[] = [];
  readonly messages: string[] = [];
  private themeName: ThemeName = 'night';

  constructor(private readonly answers: unknown[]) {}

  start(): void {}
  stop(): void {}
  clearPanel(): void {}

  setTheme(name: ThemeName): void {
    this.themeName = name;
  }

  theme(): ThemeName {
    return this.themeName;
  }

  intro(): void {}
  outro(): void {}
  cancel(): void {}

  note(message: string, title?: string): void {
    this.notes.push(title === undefined ? { message } : { message, title });
  }

  home(request: HomeRequest): Promise<string | typeof CANCEL> {
    return this.select({ message: request.message, options: request.options });
  }

  async select(opts: {
    message: string;
    options: Choice[];
    initialValue?: string;
    preview?: (value: string) => void;
  }): Promise<string | typeof CANCEL> {
    this.selects.push({ message: opts.message, options: opts.options });
    const answer = this.next();
    if (isCancel(answer) || answer === undefined) return CANCEL;
    return String(answer);
  }

  async confirm(): Promise<boolean | typeof CANCEL> {
    const answer = this.next();
    if (isCancel(answer) || answer === undefined) return CANCEL;
    return Boolean(answer);
  }

  async text(): Promise<string | undefined | typeof CANCEL> {
    const answer = this.next();
    if (isCancel(answer)) return CANCEL;
    // clack resolved an empty submission as undefined, not ''. Keep that: a
    // String() here once named an account "undefined".
    if (answer === undefined) return undefined;
    return String(answer);
  }

  async multiselect(): Promise<string[] | typeof CANCEL> {
    const answer = this.next();
    if (isCancel(answer) || answer === undefined) return CANCEL;
    return answer as string[];
  }

  spinner(): { start(message: string): void; stop(message?: string): void } {
    return { start() {}, stop() {} };
  }

  private next(): unknown {
    return this.answers.shift();
  }
}

export function offeredBy(ui: ScriptedUi, message: string): string[] {
  const prompt = ui.selects.findLast((entry) => entry.message === message);
  return (prompt?.options ?? []).map((option) => option.value);
}
