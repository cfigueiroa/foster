#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();

program
  .name('foster')
  .description(
    "Bring Claude Desktop Code sessions from a previous local account into the current account's sidebar",
  )
  .version('0.1.0');

program.parse();
