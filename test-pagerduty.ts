/**
 * PagerDuty integration test script.
 * Uses the same config and code as the daemon.
 *
 * Usage:
 *   npx ts-node test-pagerduty.ts trigger "Something is on fire"
 *   npx ts-node test-pagerduty.ts trigger "Sauna overheating" critical sauna-overheat
 *   npx ts-node test-pagerduty.ts resolve sauna-overheat
 */

import { triggerIncident, resolveIncident, Severity } from './src/pagerduty.js';

async function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case 'trigger': {
      const summary = process.argv[3];
      if (!summary) {
        console.error('Usage: npx ts-node test-pagerduty.ts trigger <summary> [severity] [dedup_key]');
        console.error('  severity: critical (default), error, warning, info');
        process.exit(1);
      }
      const severity = (process.argv[4] as Severity) ?? 'critical';
      const dedupKey = process.argv[5];
      console.log(`Triggering incident: "${summary}" [${severity}]${dedupKey ? ` dedup_key=${dedupKey}` : ''}`);
      const result = await triggerIncident(summary, severity, dedupKey);
      console.log('Result:', result);
      break;
    }
    case 'resolve': {
      const dedupKey = process.argv[3];
      if (!dedupKey) {
        console.error('Usage: npx ts-node test-pagerduty.ts resolve <dedup_key>');
        process.exit(1);
      }
      console.log(`Resolving incident: dedup_key=${dedupKey}`);
      const result = await resolveIncident(dedupKey);
      console.log('Result:', result);
      break;
    }
    default:
      console.error('Commands: trigger, resolve');
      console.error('  trigger <summary> [severity] [dedup_key]');
      console.error('  resolve <dedup_key>');
      process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
