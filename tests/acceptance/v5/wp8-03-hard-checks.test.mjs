// WP8 layer 1 hard checks on every served result, each shown on a faulty candidate (the fault is
// patched into the candidate's server in a scratch tree, then built, sealed and installed like any
// release): a result above the delivery ceiling; an excerpt served twice; two processes serving
// different text; an empty section that does not say why; the pack's probes missing their file when
// asked by the gate. Each fails the gate, though every faulty candidate still serves the gold files.
// Breaks: each check removed from the gate in turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { gate, outFile, pin, questionSet, readJson, releaseOf, setHash } from './wp8-helpers.mjs';

const FMT = 'packages/server/format.mjs';
const FAULTS = {
  size: {
    // Since wave 3 the server's last step (server/wire.mjs) holds every result to the ceiling, so the
    // faulty candidate adds its filler after that step, on the way to the wire.
    patches: [{ file: 'packages/server/main.mjs', find: '          return toolResult(r.text, r.isError, active?.recipe);', replace: "          return { content: [{ type: 'text', text: r.text + '\\n' + 'filler '.repeat(7000) }] };" }],
    expect: /size: \d+ characters above 44000/,
  },
  twice: {
    patches: [{ file: FMT, find: 'out.push(`<<<passage-${marker}`, it.excerpt, `passage-${marker}>>>`);', replace: 'out.push(`<<<passage-${marker}`, it.excerpt, `passage-${marker}>>>`, `<<<passage-${marker}`, it.excerpt, `passage-${marker}>>>`);' }],
    expect: /twice: an excerpt appears twice/,
  },
  same: {
    patches: [{ file: FMT, find: 'detail: ${result.detail}.`);', replace: 'detail: ${result.detail}. served by process ${process.pid}.`);' }],
    expect: /same: two processes served different results/,
  },
  reasons: {
    patches: [{ file: FMT, find: "if (!s.items.length) return `${s.name} (0) · no match: ${s.empty?.reason ?? 'nothing matched'}`;", replace: 'if (!s.items.length) return `${s.name} (0)`;' }],
    expect: /reasons: section FILES is empty and does not say why/,
  },
  probes: {
    // The installer's own check after the switch is left alone (it would refuse the install); only a
    // client calling itself the answer gate gets wrong answers to three-word probe questions.
    patches: [
      { file: 'packages/server/main.mjs', find: "        clientRoots = !!msg.params?.capabilities?.roots;\n", replace: "        clientRoots = !!msg.params?.capabilities?.roots;\n        globalThis.wp8Client = msg.params?.clientInfo?.name;\n" },
      { file: 'packages/server/main.mjs', find: "      const query = String(args?.query ?? '');\n", replace: "      const query = globalThis.wp8Client === 'v5-answer-gate' && String(args?.query ?? '').split(' ').length === 3 ? 'zzqqxx nothing' : String(args?.query ?? '');\n" },
    ],
    expect: /0 of 3 probes found their file/,
  },
};

for (const [name, fault] of Object.entries(FAULTS)) {
  test(`WP8 a served result that breaks the "${name}" check fails the gate`, { timeout: 300_000 }, async (t) => {
    const ctx = setup(t, 'wp8-03');
    const tree = ctx.tree({ patches: fault.patches });
    const set = questionSet(ctx);
    pin(tree, setHash(tree, set));
    const out = outFile(ctx);
    const r = gate(tree, ['--release', releaseOf(tree), '--questions', set, '--out', out]);
    assert.notEqual(r.status, 0, `a candidate with the ${name} fault must fail the gate: ${r.out}`);
    const g = readJson(out);
    assert.equal(g.passed, false);
    assert.equal(g.score.hit, 5, 'the faulty candidate still serves the gold files; only the hard check catches it');
    const found = [...g.reasons, ...g.layers.retrieval.questions.flatMap((q) => q.problems)].join('\n');
    assert.match(found, fault.expect, `the ${name} check must name the fault: ${found}`);
  });
}
