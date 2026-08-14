import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const rootLock = lock.packages?.[''] ?? {};
const errors = [];
if (!pkg.version || pkg.version !== lock.version || pkg.version !== rootLock.version) {
  errors.push(`Version mismatch: package.json=${pkg.version ?? 'missing'}, package-lock.json=${lock.version ?? 'missing'}, lock root=${rootLock.version ?? 'missing'}`);
}
const tag = String(process.env.SLEEPYCODE_RELEASE_TAG ?? '').trim();
if (tag && tag !== `v${pkg.version}`) errors.push(`Release tag ${tag} does not match package version v${pkg.version}.`);
if (pkg.name !== 'sleepycode-agent' || pkg.displayName !== 'SleepyCode') errors.push('Unexpected extension package identity.');
if (!pkg.main || pkg.main !== './dist/extension.js') errors.push('Extension main entry must be ./dist/extension.js.');
if (errors.length) {
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}
console.log(`✓ Release metadata consistent for SleepyCode v${pkg.version}`);
