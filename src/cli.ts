#!/usr/bin/env node

/**
 * TAP CLI — Terminal interface for Total Audio Platform.
 *
 * Usage:
 *   tap campaigns list
 *   tap contacts search "Radio 1"
 *   tap queue
 *   tap stats
 */

import { Command } from 'commander';
import { campaignsCommand } from './commands/campaigns.js';
import { contactsCommand } from './commands/contacts.js';
import { queueCommand } from './commands/queue.js';
import { statsCommand } from './commands/stats.js';
import { authCommand } from './commands/auth.js';

const program = new Command();

program
  .name('tap')
  .description('Total Audio Platform CLI — manage campaigns, contacts, and more')
  .version('0.1.0');

program.addCommand(authCommand());
program.addCommand(campaignsCommand());
program.addCommand(contactsCommand());
program.addCommand(queueCommand());
program.addCommand(statsCommand());

program.parse();
