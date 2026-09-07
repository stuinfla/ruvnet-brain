#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { maintenanceStatus } from '../plugin/scripts/development-maintenance.mjs';

// This command changes only repository-local development-hook configuration. Release commands
// do not import this module and do not consult the flag.
try {
  const [action = 'status', ...args] = process.argv.slice(2);
  if (!['status', 'suspend', 'resume', 'check'].includes(action)
    || (args.length && (args.length !== 2 || args[0] !== '--project'))) {
    throw new Error('Usage: node scripts/development-maintenance.mjs status|suspend|resume [--project PATH]');
  }
  const status = maintenanceStatus(args[1] || process.cwd());
  if (action === 'check') process.exit(status.suspended ? 0 : 1);
  if (!status.project) throw new Error('Project must be inside a Git working tree');
  if (action === 'status') {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else if ((action === 'suspend') === status.suspended) {
    process.stdout.write(`${JSON.stringify({ ...status, changed: false }, null, 2)}\n`);
  } else {
    const receipt = {
      schema: 1, id: randomUUID(), action, commonDir: status.commonDir,
      suspended: action === 'suspend', timestamp: new Date().toISOString(),
      scope: 'Brain development hooks only; release checks remain required',
    };
    const receiptsDir = path.join(status.commonDir, 'ruvnet-brain-maintenance-receipts');
    fs.mkdirSync(receiptsDir, { mode: 0o700, recursive: true });
    const receiptStat = fs.lstatSync(receiptsDir);
    if (!receiptStat.isDirectory() || receiptStat.isSymbolicLink()
      || (process.getuid && receiptStat.uid !== process.getuid())) throw new Error('Invalid maintenance receipt directory');
    const receiptPath = path.join(receiptsDir, `${Date.now()}-${receipt.id}.json`);
    // Record the decision before its side effect. A receipt alone never means suspension is active;
    // status reads the actual state file, and a failed write exits nonzero.
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (action === 'suspend') {
      fs.writeFileSync(status.statePath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } else {
      fs.unlinkSync(status.statePath);
    }
    process.stdout.write(`${JSON.stringify({ ...maintenanceStatus(status.project), changed: true, receiptPath }, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`development-maintenance: ${error.message}\n`);
  process.exitCode = 1;
}
