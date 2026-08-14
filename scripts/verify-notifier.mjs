import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const STALE_APP = join(ROOT, 'native/SleepyCodeNotifier.app');
const notifications = readFileSync(join(ROOT, 'src/notifications.ts'), 'utf8');
const errors = [];
if (existsSync(STALE_APP)) errors.push('A prebuilt macOS notifier app is still committed.');
if (!/spawnNotifier\('osascript'/.test(notifications)) errors.push('macOS notification fallback must use system osascript.');
if (!/sleepycode-notification\.png/.test(notifications)) errors.push('Windows/Linux notifications must use the SleepyCode notification asset.');
if (errors.length) {
  for (const error of errors) console.error('FAIL - ' + error);
  process.exit(1);
}
console.log('ok - notification paths are dependency-free and SleepyCode-branded');
