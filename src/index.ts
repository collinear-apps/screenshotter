#!/usr/bin/env node
import { main } from './cli';

main(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
