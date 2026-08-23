function windowsShellArg(value) {
  const text = String(value);
  return `"${text.replaceAll('"', '\\"')}"`;
}

export function releaseShellInvocation(command, args, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return { file: command, args, windowsVerbatimArguments: false };
  const commandLine = [command, ...args]
    .map((value, index) => index === 0 ? String(value) : windowsShellArg(value))
    .join(' ');
  const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
  if (/^(?:.*\\)?cmd(?:\.exe)?$/i.test(comspec)) {
    return {
      file: comspec,
      args: ['/d', '/s', '/c', `"${commandLine}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: comspec, args: ['-c', commandLine], windowsVerbatimArguments: false };
}
