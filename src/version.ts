import { createRequire } from 'node:module';

/**
 * The package version, read from package.json at run time (build/version.js → ../package.json), so the
 * serverInfo a client sees can never drift from the release again: until 0.5.4 it was hard-coded as 0.5.0.
 * npm always ships package.json and the Docker image copies it; anything else reports "unknown" rather
 * than a wrong number.
 */
export function readVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const VERSION = readVersion();
