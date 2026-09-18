#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../dist/cli/main.js';

const code = runCli(process.argv.slice(2), {
  env: process.env,
  globalPath: join(homedir(), '.pi', 'agent', 'jev.json'),
  projectPath: join(process.cwd(), '.pi', 'jev.json'),
  out: (text) => process.stdout.write(text + '\n'),
  err: (text) => process.stderr.write(text + '\n'),
});
process.exit(code);
