// Auth integration points for gated sites.
//   - applyAuthToContextOptions: pure, owned here (Wave 0).
//   - captureLogin / performFormLogin: implemented in ./login and ./formLogin.
import type { BrowserContextOptions } from 'playwright';
import type { AuthConfig, Mode } from '../types';

/**
 * Folds non-interactive auth into Playwright context options:
 *   - storageState (a saved-session JSON path) → loaded cookies + localStorage
 *   - basicAuth → httpCredentials
 * Returns a new options object; never mutates the input. `mode` is accepted for
 * future per-mode tweaks but is currently unused.
 */
export function applyAuthToContextOptions(
  opts: BrowserContextOptions,
  auth: AuthConfig | undefined,
  _mode: Mode,
): BrowserContextOptions {
  if (!auth) return opts;
  const next: BrowserContextOptions = { ...opts };
  if (auth.storageState) {
    next.storageState = auth.storageState;
  }
  if (auth.basicAuth) {
    next.httpCredentials = {
      username: auth.basicAuth.username,
      password: auth.basicAuth.password,
    };
  }
  return next;
}

export { captureLogin } from './login';
export { performFormLogin } from './formLogin';
