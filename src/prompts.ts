// Owned by Wave 1 / Agent A (CLI + orchestration).
// Interactively prompts only for values missing from `input`.
import prompts from 'prompts';
import type { Mode } from './types';

export interface PromptInput {
  url?: string;
  mode?: Mode;
  pages?: string[];
}

export interface PromptResult {
  url: string;
  mode: Mode;
  pages?: string[];
}

/** Normalizes a user-entered URL: prepends https:// when scheme is missing. */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** True if `value` parses as a non-empty http(s) URL (after normalization). */
function isValidUrl(value: string): boolean {
  const normalized = normalizeUrl(value);
  if (!normalized) return false;
  try {
    const u = new URL(normalized);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Splits a comma/whitespace separated list into trimmed, non-empty entries. */
export function parsePagesList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/** Interactively prompts only for values missing from `input`. */
export async function promptForMissing(input: PromptInput): Promise<PromptResult> {
  const needUrl = !input.url || input.url.trim().length === 0;
  const needMode = !input.mode;
  const needPages = input.pages === undefined;

  // Non-interactive environments cannot answer prompts. Only the URL is
  // strictly required; mode/pages have safe defaults, so we only hard-fail
  // when a required value is missing and we cannot ask for it.
  if (!process.stdin.isTTY && needUrl) {
    throw new Error(
      'A target URL is required. Pass it as the first argument (e.g. `screenshotter https://example.com`) ' +
        'because stdin is not a TTY and cannot be prompted.',
    );
  }

  // Non-interactive (piped/CI) runs must never block on a prompt. The URL is
  // guaranteed present by the guard above; mode/pages fall back to safe defaults
  // (web / auto-discover) so an omitted optional flag does NOT trigger a prompt.
  if (!process.stdin.isTTY) {
    return {
      url: normalizeUrl(input.url as string),
      mode: input.mode ?? 'web',
      pages: input.pages && input.pages.length > 0 ? input.pages : undefined,
    };
  }

  const questions: prompts.PromptObject[] = [];

  if (needUrl) {
    questions.push({
      type: 'text',
      name: 'url',
      message: 'Website URL to capture',
      validate: (value: string) =>
        isValidUrl(value) ? true : 'Please enter a valid http(s) URL.',
    });
  }

  if (needMode) {
    questions.push({
      type: 'select',
      name: 'mode',
      message: 'Capture mode',
      choices: [
        { title: 'web (desktop)', value: 'web' },
        { title: 'mobile', value: 'mobile' },
      ],
      initial: 0,
    });
  }

  if (needPages) {
    questions.push({
      type: 'text',
      name: 'pages',
      message: 'Pages to capture (comma/space separated; blank = auto-discover)',
    });
  }

  let cancelled = false;
  const answers =
    questions.length > 0
      ? await prompts(questions, {
          onCancel: () => {
            cancelled = true;
          },
        })
      : ({} as prompts.Answers<string>);

  if (cancelled) {
    throw new Error('Prompt cancelled by user.');
  }

  // URL
  let url: string;
  if (needUrl) {
    const answered = answers.url as string | undefined;
    if (!answered || !isValidUrl(answered)) {
      throw new Error('A valid target URL is required.');
    }
    url = normalizeUrl(answered);
  } else {
    url = normalizeUrl(input.url as string);
  }

  // Mode
  let mode: Mode;
  if (needMode) {
    const answered = answers.mode as Mode | undefined;
    mode = answered === 'mobile' ? 'mobile' : 'web';
  } else {
    mode = input.mode as Mode;
  }

  // Pages
  let pages: string[] | undefined;
  if (needPages) {
    pages = parsePagesList(answers.pages as string | undefined);
  } else {
    pages = input.pages && input.pages.length > 0 ? input.pages : undefined;
  }

  return { url, mode, pages };
}
