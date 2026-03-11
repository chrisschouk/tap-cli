/**
 * Action queue command for the TAP CLI.
 */

import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { getClient, resolveWorkspaceId } from '../auth.js';
import * as out from '../output.js';

export function queueCommand(): Command {
  return new Command('queue')
    .description("Show today's action queue")
    .option('-w, --workspace <id>', 'Workspace ID')
    .option('--json', 'Output as JSON')
    .action(async opts => {
      const spinner = ora('Loading action queue...').start();

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        // Active campaigns
        const { data: campaigns } = await supabase
          .from('tap_projects')
          .select('id, name, artist_name')
          .eq('workspace_id', wsId)
          .eq('status', 'active');

        if (!campaigns || campaigns.length === 0) {
          spinner.stop();
          out.info('No active campaigns. Nothing in the queue.');
          return;
        }

        const campaignIds = campaigns.map(c => c.id);
        const campaignMap = new Map(campaigns.map(c => [c.id, c]));

        // Follow-ups needed (pitched > 3 days ago, no reply)
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

        const { data: followUps } = await supabase
          .from('campaign_contacts')
          .select('contact_id, project_id, updated_at')
          .in('project_id', campaignIds)
          .eq('pitch_status', 'sent')
          .lt('updated_at', threeDaysAgo.toISOString())
          .limit(10);

        // Unenriched contacts
        const { count: unenrichedCount } = await supabase
          .from('tap_contacts')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', wsId)
          .is('enriched_at', null);

        // Unpitched contacts in active campaigns
        const { count: unpitchedCount } = await supabase
          .from('campaign_contacts')
          .select('contact_id', { count: 'exact', head: true })
          .in('project_id', campaignIds)
          .eq('pitch_status', 'not_pitched');

        spinner.stop();

        if (opts.json) {
          out.json({
            followUps,
            unenrichedCount,
            unpitchedCount,
            activeCampaigns: campaigns.length,
          });
          return;
        }

        console.log();
        console.log(chalk.bold(`Action Queue — ${new Date().toLocaleDateString('en-GB')}`));
        console.log(
          chalk.dim(`${campaigns.length} active campaign${campaigns.length === 1 ? '' : 's'}`)
        );
        console.log();

        // Follow-ups
        if (followUps && followUps.length > 0) {
          console.log(chalk.red.bold(`Follow-ups needed (${followUps.length})`));
          for (const f of followUps) {
            const campaign = campaignMap.get(f.project_id);
            const daysAgo = Math.floor((Date.now() - new Date(f.updated_at).getTime()) / 86400000);
            console.log(
              `  ${chalk.dim('•')} ${campaign?.name || f.project_id} — contact ${f.contact_id.slice(0, 8)}… (${daysAgo}d ago)`
            );
          }
          console.log();
        }

        // Enrichment
        if (unenrichedCount && unenrichedCount > 0) {
          console.log(chalk.yellow(`${unenrichedCount} contacts need enrichment`));
        }

        // Unpitched
        if (unpitchedCount && unpitchedCount > 0) {
          console.log(
            chalk.cyan(`${unpitchedCount} contacts not yet pitched across active campaigns`)
          );
        }

        if (!followUps?.length && !unenrichedCount && !unpitchedCount) {
          out.success('Queue is clear. Nice work.');
        }

        console.log();
      } catch (err) {
        spinner.stop();
        out.error(err instanceof Error ? err.message : 'Unknown error');
        process.exit(1);
      }
    });
}
