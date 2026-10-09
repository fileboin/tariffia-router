#!/usr/bin/env node
/**
 * Tariffia CLI.
 *
 * Only one command so far: `serve`, which starts the local OpenAI/Anthropic
 * compatible endpoint. It delegates to the existing modules and adds no routing
 * logic of its own.
 *
 * Usage:
 *   tariffia serve
 *   TARIFFIA_MODE=FREE_ONLY TARIFFIA_PORT=8910 tariffia serve
 *
 * Tariffia addition (2026-10-04). See THIRD_PARTY_NOTICES.md.
 */

import { runServe } from '../serve.js';

const HELP = `tariffia — universal AI model router

Usage:
  tariffia serve            start the local OpenAI/Anthropic-compatible endpoint
  tariffia help             show this help

Environment:
  TARIFFIA_REGISTRY   registry file (default: registry/ollama.json)
  TARIFFIA_MODE       FREE_ONLY | BALANCED | FREE_FIRST | CUSTOM (default FREE_ONLY)
  TARIFFIA_MAX_PRICE_PER_MTOK  maximum USD per 1M input AND output tokens;
                              absent/invalid disables paid candidates
  TARIFFIA_HOST       bind host (default 127.0.0.1)
  TARIFFIA_PORT       bind port (default 8910)
  TARIFFIA_TOKEN      bearer token clients must present
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cmd = argv[0];

  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }

  if (cmd === 'serve') {
    try {
      await runServe(process.env);
      return 0;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`tariffia: ${reason}\n`);
      return 1;
    }
  }

  process.stderr.write(`tariffia: unknown command '${String(cmd)}'\n\n${HELP}`);
  return 1;
}

// Run only when invoked as the bin, not when imported (tests import `main`).
const invokedDirectly = process.argv[1] !== undefined && /(?:^|[/\\])cli[/\\]index\.(?:js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
