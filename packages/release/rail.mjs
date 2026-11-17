#!/usr/bin/env node
// The release rail's one command line (architecture 2.5). The v5 workflows call only this.
//   seal      --pack <dir> --out <dir> --version X --release-number N [--branch <ref>]   (key: $RUVNET_BRAIN5_SIGNING_KEY)
//   verify    --release <dir>
//   stage     --release <dir> --channel <dir> [--github-output <file>]
//   probe     --release <dir> --out <receipt.json>
//   promote   --channel <dir> --tag <tag> --version X --receipts <dir> [--gate <file>] [--outcome <file>]
//   dispatch-decision --slot first|retry --runs <file> [--kill-switch <value>] [--github-output <file>]
//   gather    --repo <owner/name> --out <file>
//   watchdog  --runs <file>
//   shipped-files --check | --write
// Exit 0 done, 1 refused or red (one plain sentence on stderr), 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, listFiles, readJson, writeJsonAtomic } from '../contract/home.mjs';
import { trustedPublicKey } from '../contract/signature.mjs';
import { RAIL, Refused, verifyStaged } from './checks.mjs';
import { decideDispatch, gather, judge } from './nightly.mjs';
import { installAndProbe } from './probe.mjs';
import { fsChannel, promote, stage } from './promote.mjs';
import { appFiles, checkShipped, seal } from './seal.mjs';

const USAGE = 'usage: node packages/release/rail.mjs seal|verify|stage|probe|promote|dispatch-decision|gather|watchdog|shipped-files [options] (see the head of rail.mjs)';

function trusted() {
  try {
    return trustedPublicKey();
  } catch (e) {
    throw new Refused(e.message);
  }
}

const readDirJson = (dir) => (fs.existsSync(dir) ? listFiles(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f), null)) : []);
const output = (file, pairs) => file && fs.appendFileSync(file, Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join(''));

export async function main(argv) {
  const [cmd, ...args] = argv;
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i < 0 ? null : args[i + 1] ?? null;
  };
  const need = (name) => {
    const v = opt(name);
    if (v === null || v.startsWith('--')) throw new UsageError(`--${name} is required`);
    return v;
  };
  const abs = (name) => path.resolve(need(name));
  switch (cmd) {
    case 'seal': {
      const r = seal({ packDir: abs('pack'), outDir: abs('out'), version: need('version'), branch: opt('branch'), releaseNumber: Number(need('release-number')), privateKeyPem: process.env[RAIL.signingKeyEnv] || null });
      return `sealed release ${r.release.releaseNumber}: app ${r.release.app.version}, pack ${r.release.pack.generation}, ${r.probes} probes passed, release.json sha256 ${r.sha256}`;
    }
    case 'verify': {
      const r = verifyStaged(abs('release'), trusted());
      return `verified release ${r.release.releaseNumber}: every file matches the signature; release.json sha256 ${r.sha256}`;
    }
    case 'stage': {
      const tag = stage({ releaseDir: abs('release'), channel: fsChannel(abs('channel')), publicKeyPem: trusted() });
      output(opt('github-output'), { tag });
      return `staged ${tag} as a pre-release`;
    }
    case 'probe': {
      const receipt = await installAndProbe({ releaseDir: abs('release') });
      writeJsonAtomic(abs('out'), receipt);
      if (!receipt.ok) throw new Refused(`install-and-probe failed on ${receipt.os}: ${receipt.error}`);
      return `install-and-probe ok on ${receipt.os}: ${receipt.probes.length} probes found their file; doctor: ${receipt.doctor.line}`;
    }
    case 'promote': {
      const gateFile = opt('gate');
      const gate = gateFile && fs.existsSync(gateFile) ? readJson(gateFile, null) : null;
      const r = promote({ tag: need('tag'), channel: fsChannel(abs('channel')), receipts: readDirJson(abs('receipts')), gate, version: need('version'), publicKeyPem: trusted() });
      if (opt('outcome')) writeJsonAtomic(path.resolve(opt('outcome')), { outcome: r.outcome, tag: r.tag, at: new Date().toISOString() });
      return `${r.outcome}: ${r.tag}`;
    }
    case 'dispatch-decision': {
      const d = decideDispatch({ killSwitch: opt('kill-switch'), slot: need('slot'), runs: readJson(abs('runs')), now: Date.now() });
      output(opt('github-output'), { dispatch: d.dispatch });
      return `dispatch=${d.dispatch} · ${d.reason}`;
    }
    case 'gather': {
      writeJsonAtomic(abs('out'), gather({ repo: need('repo'), now: Date.now() }));
      return `wrote ${need('out')}`;
    }
    case 'watchdog': {
      const j = judge({ runs: readJson(abs('runs')), now: Date.now() });
      if (j.red) process.exitCode = 1;
      return j.lines.join('\n');
    }
    case 'shipped-files': {
      if (args.includes('--write')) {
        // The trusted public key ships in the app; it is listed even before the lead provisions it.
        const app = [...new Set([...appFiles(), 'contract/keys/release-public.pem'])].sort();
        writeJsonAtomic(fileURLToPath(new URL('shipped-files.json', import.meta.url)), { app });
        return 'wrote packages/release/shipped-files.json from the current tree; review the diff';
      }
      return `${checkShipped().length} app files match the reviewed list`;
    }
    default:
      throw new UsageError(cmd ? `unknown command ${cmd}` : 'no command');
  }
}

class UsageError extends Error {}

if (isMain(import.meta.url)) {
  try {
    console.log(await main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error(e instanceof Refused ? `refused: ${e.message}` : `failed: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
