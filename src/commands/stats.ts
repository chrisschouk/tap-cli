/**
 * Stats command for the TAP CLI.
 */

import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { getClient, resolveWorkspaceId } from '../auth.js';
import * as out from '../output.js';

export function statsCommand(): Command {
  return new Command('stats')
    .description('Show workspace statistics')
    .option('-w, --workspace <id>', 'Workspace ID')
    .option('--json', 'Output as JSON')
    .action(async opts => {
      const spinner = ora('Loading stats...').start();

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        const [
          { count: totalContacts },
          { count: enrichedContacts },
          { count: totalCampaigns },
          { count: activeCampaigns },
          { count: totalOutcomes },
          { count: totalPitches },
        ] = await Promise.all([
          supabase
            .from('tap_contacts')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', wsId),
          supabase
            .from('tap_contacts')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', wsId)
            .not('enriched_at', 'is', null),
          supabase
            .from('tap_projects')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', wsId),
          supabase
            .from('tap_projects')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', wsId)
            .eq('status', 'active'),
          supabase
            .from('tap_contact_outcomes')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', wsId),
          supabase
            .from('campaign_pitch_drafts')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', wsId),
        ]);

        spinner.stop();

        const stats = {
          contacts: { total: totalContacts || 0, enriched: enrichedContacts || 0 },
          campaigns: { total: totalCampaigns || 0, active: activeCampaigns || 0 },
          outcomes: totalOutcomes || 0,
          pitches: totalPitches || 0,
        };

        if (opts.json) {
          out.json(stats);
          return;
        }

        console.log();
        console.log(chalk.bold('TAP Workspace Stats'));
        console.log();
        console.log(
          `  Contacts:   ${chalk.cyan(stats.contacts.total)} total, ${chalk.green(stats.contacts.enriched)} enriched`
        );
        console.log(
          `  Campaigns:  ${chalk.cyan(stats.campaigns.total)} total, ${chalk.green(stats.campaigns.active)} active`
        );
        console.log(`  Outcomes:   ${chalk.cyan(stats.outcomes)}`);
        console.log(`  Pitches:    ${chalk.cyan(stats.pitches)} drafts`);
        console.log();

        if (stats.contacts.total > 0) {
          const enrichRate = Math.round((stats.contacts.enriched / stats.contacts.total) * 100);
          console.log(`  Enrichment rate: ${enrichRate}%`);
        }

        console.log();
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : 'Unknown error');
        process.exit(1);
      }
    });
}
