// CI version guard (the "Version bumped with src/" job).
// 1. server.json's version and every package version must equal package.json's version.
// 2. When src/ changed, package.json's version must be strictly greater (SemVer) than the base's.
// Usage: node scripts/check-version.mjs <base package.json> <src-changed: 0|1>
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Compare two SemVer strings: negative, 0 or positive. Throws on an invalid version. */
export function compareSemver(a, b) {
  const pa = SEMVER.exec(a), pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error(`not a SemVer version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  // A pre-release sorts below its release; otherwise compare identifiers left to right.
  if (!pa[4] || !pb[4]) return (pa[4] ? -1 : 0) - (pb[4] ? -1 : 0);
  const xa = pa[4].split('.'), xb = pb[4].split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]), nb = /^\d+$/.test(xb[i]);
    if (na && nb) { const d = Number(xa[i]) - Number(xb[i]); if (d) return d; continue; }
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

/** Returns the problem as a string, or null when the versions are fine. */
export function versionProblem({ pkgVersion, server, baseVersion, srcChanged }) {
  const manifest = [['server.json version', server?.version],
    ...(server?.packages ?? []).map((p, i) => [`server.json packages[${i}].version`, p?.version])];
  if (manifest.length < 2) return 'server.json has no packages';
  for (const [where, v] of manifest) {
    if (v !== pkgVersion) return `${where} is ${v ?? 'missing'} but package.json is ${pkgVersion}`;
  }
  if (!srcChanged) return null;
  if (compareSemver(pkgVersion, baseVersion) <= 0) {
    return `src/ changed but package.json ${pkgVersion} is not above the base's ${baseVersion}. ` +
      'Bump it (npm version patch --no-git-tag-version) and set the same version in server.json.';
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const pkgVersion = read('package.json').version;
  const baseVersion = read(process.argv[2]).version;
  const srcChanged = process.argv[3] === '1';
  let problem;
  try {
    problem = versionProblem({ pkgVersion, server: read('server.json'), baseVersion, srcChanged });
  } catch (e) {
    problem = e.message;
  }
  if (problem) { console.log(`::error::${problem}`); process.exit(1); }
  console.log(srcChanged ? `src/ changed; version ${baseVersion} -> ${pkgVersion}` : 'versions agree; src/ unchanged');
}
