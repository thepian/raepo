#!/usr/bin/env node
import { buildAnalyze } from './analyze.ts';
import { buildError, buildVersion, type Command } from './command.ts';
import { buildConfig } from './config.ts';
import { buildHelp } from './help.ts';
import { parseArgs } from './parse.ts';

function buildCommand(argv: string[]): Command {
  const r = parseArgs(argv);
  switch (r.mode) {
    case 'help':
      return buildHelp(r);
    case 'version':
      return buildVersion(r);
    case 'config':
      return buildConfig(r);
    case 'analyze':
      return buildAnalyze(r);
    case 'error':
      return buildError(r);
  }
  return buildHelp(r); // just in principle, the switch is complete
}

async function main(argv: string[]): Promise<number> {
  process.on('SIGINT', () => process.exit(130));
  const cmd = buildCommand(argv.slice(2));
  return cmd.run();
}

const code = await main(process.argv);
process.exit(code);
