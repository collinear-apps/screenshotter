// Safety gate for the --full explorer. Decides whether a clickable may be clicked.
// Two tiers:
//   - HARD_DENY: never clicked, even in --aggressive (session-ending / financial /
//     account-destroying). This is the floor that protects against the worst cases.
//   - DESTRUCTIVE: skipped in SAFE mode; allowed in --aggressive.
import type { Clickable } from '../types';

/** Never click these, in ANY mode. */
const HARD_DENY =
  /\b(log\s?out|sign\s?out|logout|signout|delete\s+account|close\s+account|deactivate|pay\b|payment|checkout|place\s+order|buy\s+now|purchase|billing|subscribe\b|upgrade\s+plan)\b/i;

/** Skipped in safe mode (mutations / irreversible-ish); allowed when aggressive. */
const DESTRUCTIVE =
  /\b(delete|remove|destroy|discard|reset|revoke|cancel|unsubscribe|archive|block|report|flag|send|post\b|publish|submit|save|confirm|approve|reject|merge|transfer|withdraw|leave\b|disconnect)\b/i;

/** Result of a safety decision. */
export interface SafetyDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether `c` may be clicked. External-origin links are always skipped
 * (would navigate away from the app under test).
 */
export function decide(
  c: Clickable,
  aggressive: boolean,
  externalLink: boolean,
): SafetyDecision {
  if (externalLink) return { allowed: false, reason: 'external-link' };

  const label = (c.label || '').trim();

  if (HARD_DENY.test(label)) {
    return { allowed: false, reason: 'hard-deny (logout/payment/account)' };
  }

  if (!aggressive && DESTRUCTIVE.test(label)) {
    return { allowed: false, reason: 'destructive (safe mode)' };
  }

  return { allowed: true };
}

/**
 * Whether a form may be SUBMITTED. Safe mode allows only search/filter forms.
 * Aggressive allows submits (HARD_DENY labels are still blocked by `decide`).
 */
export function maySubmitForm(label: string, aggressive: boolean): boolean {
  if (aggressive) return !HARD_DENY.test(label);
  return /\b(search|filter|find|query|go)\b/i.test(label);
}
