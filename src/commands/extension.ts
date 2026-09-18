import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { runCli, type CliIo } from '../cli/main.js';
import { defaultConfigPaths } from '../shared/config.js';

/**
 * Core of the `/jev` command: same engine as the `pi-jev` CLI. Split out so
 * tests can drive it against temp config files.
 */
export function runJevCommand(rawArgs: string, io: CliIo): number {
  const argv = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (argv[0] === 'config') argv.shift(); // tolerate `/jev config ...`
  return runCli(argv.length > 0 ? ['config', ...argv] : ['config'], io);
}

/**
 * The command extension: `/jev` configures the suite from inside pi.
 * Config is re-read by every hook, so changes apply without a restart.
 *
 *   /jev                      show resolved values + each value's source
 *   /jev set <key> <value>    write a key (`-l` targets the project file)
 *   /jev get <key>            /jev unset <key>   /jev keys   /jev path
 */
export default function (pi: ExtensionAPI): void {
  pi.registerCommand('jev', {
    description: 'Configure pi-jev: /jev [set|get|unset|keys|path] ...',
    handler: async (args, ctx) => {
      const lines: string[] = [];
      const errs: string[] = [];
      const code = runJevCommand(args ?? '', {
        env: process.env,
        ...defaultConfigPaths(),
        out: (text) => {
          lines.push(text);
        },
        err: (text) => {
          errs.push(text);
        },
      });
      const text = [...lines, ...errs].join('\n').trim();
      ctx.ui.notify(text || '(no output)', code === 0 ? 'info' : 'error');
    },
  });
}
