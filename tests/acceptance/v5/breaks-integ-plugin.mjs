// The breaks of the plug-in review-fix tests (integ-plugin-*.test.mjs; docs/REVIEW-FIXES.md F02, F06,
// F13). Each removes one protection the fix added and names the failure its test must show.
const RB5 = 'packages/plugin/claude/bin/rb5';
const INSTALL = 'packages/plugin/install.mjs';
const BACKUP = 'packages/plugin/host-backup.mjs';
const p = (file, find, replace) => ({ file, find, replace });

export function addIntegPluginBreaks(BREAKS) {
  Object.assign(BREAKS, {
    // F02: the POSIX launcher follows a linked node to its end
    'integ-plugin-f02-no-hops': { test: 'integ-plugin-f02', what: 'the launcher checks the link\'s folder but not where it points', patches: [p(RB5, '    [ -h "$u_c" ] || return 0\n', '    return 0\n')], expect: /a one-hop link into the project: a node linked into the project ran/ },
    'integ-plugin-f02-first-hop': { test: 'integ-plugin-f02', what: 'the launcher follows only the first hop of a link chain', patches: [p(RB5, '    [ "$u_n" -le 16 ] || return 1\n', '    [ "$u_n" -le 1 ] || return 0\n')], expect: /a two-hop link \(relative second hop\) into the project: a node linked into the project ran/ },
    'integ-plugin-f02-no-links': { test: 'integ-plugin-f02', what: 'the launcher refuses every linked node', patches: [p(RB5, '    [ -h "$u_c" ] || return 0\n', '    [ -h "$u_c" ] || return 0\n    return 1\n')], expect: /a Homebrew-style link chain outside the project must still run/ },
    // F06: no host file is reached through a link below its host folder
    'integ-plugin-f06-links': { test: 'integ-plugin-f06', what: 'a link below the host folder is followed', patches: [p(INSTALL, '    if (st.isSymbolicLink()) throw new HostRefused(', '    if (false) throw new HostRefused(')], expect: /a nested link to an ordinary folder must be refused: written through a link/ },
    'integ-plugin-f06-ancestors': { test: 'integ-plugin-f06', what: 'the protected-home check skips the real path of each part', patches: [p(INSTALL, '    refuseProtected([fs.realpathSync(cur)]);\n', '')], expect: /a nested link into a protected home must be refused naming that home/ },
    'integ-plugin-f06-strict-base': { test: 'integ-plugin-f06', what: 'the walk starts above the host folder, so a dotfiles host folder link is refused', patches: [p(INSTALL, '  let cur = resolved(base);\n', '  let cur = resolved(path.dirname(base));\n'), p(INSTALL, 'path.relative(path.resolve(base), path.resolve(file))', 'path.relative(path.dirname(path.resolve(base)), path.resolve(file))')], expect: /a linked host folder \(dotfiles\) must still register/ },
    // F13: only our own hooks go; an unterminated block is refused; modes are kept
    'integ-plugin-f13-whole-group': { test: 'integ-plugin-f13', what: 'uninstall removes the whole group that holds our hook', patches: [p(INSTALL, '    return rest.length ? { ...g, hooks: rest } : null;', '    return null;')], expect: /a hook the user added to the registered group must stay after uninstall/ },
    'integ-plugin-f13-to-eof': { test: 'integ-plugin-f13', what: 'an unterminated managed block is cut to the end of the file', patches: [p(INSTALL, '  if (s >= 0 && e < 0) throw new HostRefused(', '  if (false) throw new HostRefused(')], expect: /an unterminated managed block must be refused by registration/ },
    'integ-plugin-f13-mode': { test: 'integ-plugin-f13', what: 'a replaced host file takes the default mode', patches: [p(BACKUP, '    mode = fs.statSync(file).mode & 0o777;\n', '')], expect: /registration: each host file keeps its mode/ },
    'integ-plugin-f13-restore-mode': { test: 'integ-plugin-f13', what: 'the byte-exact restore writes without the mode', patches: [p(BACKUP, '  if (b.existed) replaceFile(file, b.text);', "  if (b.existed) {\n    fs.rmSync(file, { force: true });\n    fs.writeFileSync(file, b.text);\n  }")], expect: /the byte-exact restore: each host file keeps its mode/ },
  });
}
