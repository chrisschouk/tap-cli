/**
 * Campaign commands for the TAP CLI.
 */

import { Command } from 'commander';
import ora from 'ora';
import { getClient, resolveWorkspaceId } from '../auth.js';
import * as out from '../output.js';

export function campaignsCommand(): Command {
  const cmd = new Command('campaigns').description('Manage campaigns');

  cmd
    .command('list')
    .description('List campaigns')
    .option('-s, --status <status>', 'Filter by status (draft, active, completed, archived)')
    .option('-w, --workspace <id>', 'Workspace ID')
    .option('--json', 'Output as JSON')
    .action(async opts => {
      const spinner = ora('Fetching campaigns...').start();

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        let query = supabase
          .from('tap_projects')
          .select('id, name, artist_name, status, release_name, release_date, created_at')
          .eq('workspace_id', wsId)
          .order('created_at', { ascending: false })
          .limit(50);

        if (opts.status) query = query.eq('status', opts.status);

        const { data, error } = await query;
        spinner.stop();

        if (error) {
          out.error(error.message);
          process.exit(1);
        }

        if (opts.json) {
          out.json(data);
          return;
        }

        if (!data || data.length === 0) {
          out.info('No campaigns found');
          return;
        }

        out.table(
          ['Name', 'Artist', 'Status', 'Release', 'Created'],
          data.map(c => [
            out.truncate(c.name, 30),
            out.truncate(c.artist_name, 20) || '—',
            out.statusBadge(c.status),
            c.release_date || '—',
            new Date(c.created_at).toLocaleDateString('en-GB'),
          ])
        );

        out.info(`${data.length} campaigns`);
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : 'Unknown error');
        process.exit(1);
      }
    });

  cmd
    .command('create')
    .description('Create a new campaign')
    .requiredOption('-n, --name <name>', 'Campaign name')
    .option('-a, --artist <name>', 'Artist name')
    .option('-r, --release <name>', 'Release name')
    .option('-d, --date <date>', 'Release date (YYYY-MM-DD)')
    .option('-c, --channels <channels>', 'Channels (comma-separated: radio,press,playlist)')
    .option('-w, --workspace <id>', 'Workspace ID')
    .action(async opts => {
      const spinner = ora('Creating campaign...').start();

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        const { data, error } = await supabase
          .from('tap_projects')
          .insert({
            workspace_id: wsId,
            name: opts.name,
            artist_name: opts.artist || null,
            release_name: opts.release || null,
            release_date: opts.date || null,
            services: opts.channels ? opts.channels.split(',') : null,
            status: 'draft',
          })
          .select('id, name')
          .single();

        spinner.stop();

        if (error) {
          out.error(error.message);
          process.exit(1);
        }

        out.success(`Campaign "${data.name}" created (${data.id})`);
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : 'Unknown error');
        process.exit(1);
      }
    });

  cmd
    .command('status')
    .description('Change campaign status')
    .argument('<id>', 'Campaign ID')
    .argument('<status>', 'New status (draft, active, paused, completed, archived)')
    .action(async (id, status) => {
      const validStatuses = ['draft', 'active', 'paused', 'completed', 'archived'];
      if (!validStatuses.includes(status)) {
        out.error(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
        process.exit(1);
      }

      const spinner = ora('Updating status...').start();

      try {
        const supabase = getClient();

        const { data, error } = await supabase
          .from('tap_projects')
          .update({ status })
          .eq('id', id)
          .select('id');

        spinner.stop();

        if (error) {
          out.error(error.message);
          process.exit(1);
        }

        if (!data || data.length === 0) {
          out.error(`Campaign not found: ${id}`);
          process.exit(1);
        }

        out.success(`Campaign ${id} → ${out.statusBadge(status)}`);
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : 'Unknown error');
        process.exit(1);
      }
    });

  return cmd;
}
