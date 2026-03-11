/**
 * Send command -- pitch-to-inbox pipeline from terminal.
 *
 * Usage:
 *   tap send <pitch-id>              -- send a pitch draft via Gmail
 *   tap send <pitch-id> --dry-run    -- preview without sending
 *   tap send <pitch-id> --confirm    -- skip confirmation prompt
 */

import { Command } from "commander";
import chalk from "chalk";
import * as prompts from "@clack/prompts";
import { getClient, resolveWorkspaceId } from "../auth.js";
import * as out from "../output.js";
import { warningBlock, navHint } from "../ui/detail.js";
import { createRailSpinner, stepComplete, blank, summaryBar } from "../ui/format.js";
import { handleError } from "../ui/errors.js";
import {
  getGmailConnection,
  ensureFreshToken,
  buildRawMessage,
  sendGmailMessage,
  getDailySendCount,
} from "../lib/gmail.js";

const DAILY_SEND_CAP = 50;

export function sendCommand(): Command {
  return new Command("send")
    .description("Send a pitch draft via Gmail")
    .argument("<pitch-id>", "Pitch draft ID")
    .option("-w, --workspace <id>", "Workspace ID")
    .option("--confirm", "Skip confirmation prompt")
    .option("--dry-run", "Preview without sending")
    .option("--json", "Structured output with message ID")
    .action(async (pitchId, opts) => {
      const rail = createRailSpinner("Loading pitch").start();

      try {
        const supabase = getClient();
        const wsId = await resolveWorkspaceId(supabase, opts.workspace);

        // Fetch pitch draft
        const { data: pitch, error: pitchErr } = await supabase
          .from("campaign_pitch_drafts")
          .select(
            "id, subject, body, campaign_id, contact_id, send_status, sent_at",
          )
          .eq("id", pitchId)
          .single();

        if (pitchErr || !pitch) {
          rail.fail(pitchErr?.message || `Pitch not found: ${pitchId}`);
          process.exit(1);
        }

        if (pitch.send_status === "sent") {
          rail.fail(`Already sent on ${pitch.sent_at ? new Date(pitch.sent_at).toLocaleDateString("en-GB") : "unknown date"}`);
          process.exit(1);
        }

        rail.succeed("Loading pitch");

        // Resolve contact and campaign in parallel
        const contactRail = createRailSpinner("Resolving contact").start();

        const [contactResult, campaignResult, gmailConn, dailyCount] =
          await Promise.all([
            pitch.contact_id
              ? supabase
                  .from("tap_contacts")
                  .select("id, name, email, outlet, last_contacted_at, total_pitches, cooling_off, pitch_embargo_until")
                  .eq("id", pitch.contact_id)
                  .single()
              : Promise.resolve({ data: null, error: null }),
            pitch.campaign_id
              ? supabase
                  .from("tap_projects")
                  .select("id, name, artist_name")
                  .eq("id", pitch.campaign_id)
                  .single()
              : Promise.resolve({ data: null, error: null }),
            getGmailConnection(supabase, wsId),
            getDailySendCount(supabase, wsId),
          ]);

        const contact = contactResult.data;
        const campaign = campaignResult.data;

        if (!contact?.email) {
          contactRail.fail("No contact email associated with this pitch");
          process.exit(1);
        }

        contactRail.succeed(`Resolving contact        ${contact.name || ""} <${contact.email}>`);

        if (!gmailConn && !opts.dryRun) {
          out.error(
            "No Gmail connection. Connect in TAP: tap.totalaudiopromo.com/settings/integrations",
          );
          process.exit(1);
        }

        if (dailyCount >= DAILY_SEND_CAP && !opts.dryRun) {
          out.error(
            `Daily send limit reached (${dailyCount}/${DAILY_SEND_CAP}). Try again tomorrow.`,
          );
          process.exit(1);
        }

        stepComplete(`Checking Gmail           ${dailyCount}/${DAILY_SEND_CAP} daily cap`);

        // Relationship warnings
        const warnings: string[] = [];
        if (contact.total_pitches && contact.total_pitches >= 3) {
          const ninetyDaysAgo = new Date();
          ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
          const { count: recentPitches } = await supabase
            .from("campaign_contacts")
            .select("id", { count: "exact", head: true })
            .eq("contact_id", contact.id)
            .not("last_pitched_at", "is", null)
            .gte("last_pitched_at", ninetyDaysAgo.toISOString());

          if (recentPitches && recentPitches >= 3) {
            warnings.push(
              `${contact.name || contact.email} was pitched ${recentPitches} times in the last 90 days`,
            );
          }
        }

        if (contact.cooling_off) {
          warnings.push(`${contact.name || contact.email} is in a cooling off period`);
        }

        if (contact.pitch_embargo_until) {
          const embargo = new Date(contact.pitch_embargo_until);
          if (embargo > new Date()) {
            warnings.push(
              `Pitch embargo until ${embargo.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`,
            );
          }
        }

        // Check for recent declined outcome
        const { data: recentDeclined } = await supabase
          .from("tap_contact_outcomes")
          .select("occurred_at")
          .eq("contact_id", contact.id)
          .eq("outcome_type", "declined")
          .order("occurred_at", { ascending: false })
          .limit(1);

        if (recentDeclined && recentDeclined.length > 0) {
          const declinedDate = new Date(recentDeclined[0].occurred_at);
          const daysSince = Math.floor(
            (Date.now() - declinedDate.getTime()) / 86400000,
          );
          if (daysSince <= 14) {
            warnings.push(
              `Last pitch was declined ${daysSince} day${daysSince === 1 ? "" : "s"} ago`,
            );
          }
        }

        if (warnings.length > 0) {
          warningBlock(warnings);
        }

        // Preview
        blank();
        console.log(`  ${chalk.dim("To".padEnd(12))}${contact.name || ""} <${contact.email}>`);
        console.log(`  ${chalk.dim("Subject".padEnd(12))}${pitch.subject}`);
        if (campaign) {
          const campaignLabel = campaign.artist_name
            ? `${campaign.artist_name} -- ${campaign.name}`
            : campaign.name;
          console.log(`  ${chalk.dim("Campaign".padEnd(12))}${campaignLabel}`);
        }

        blank();
        console.log(`  ${chalk.dim("Preview:")}`);
        const allBodyLines = pitch.body.split("\n");
        for (const line of allBodyLines.slice(0, 5)) {
          console.log(`  ${line}`);
        }
        if (allBodyLines.length > 5) {
          console.log(chalk.dim(`  [truncated at 5 lines]`));
        }
        blank();

        if (opts.dryRun) {
          out.info("Dry run -- nothing sent");
          if (opts.json) {
            out.json({
              dryRun: true,
              to: contact.email,
              subject: pitch.subject,
              campaignId: pitch.campaign_id,
              warnings,
            });
          }
          return;
        }

        // Confirmation
        if (!opts.confirm) {
          const confirmed = await prompts.confirm({
            message: "Send this pitch?",
          });
          if (prompts.isCancel(confirmed) || !confirmed) {
            console.log(chalk.dim("  Cancelled."));
            return;
          }
        }

        // Send
        blank();
        const sendRail = createRailSpinner("Sending via Gmail").start();

        const accessToken = await ensureFreshToken(supabase, gmailConn!);
        const rawMessage = buildRawMessage(
          contact.email,
          pitch.subject,
          pitch.body,
          gmailConn!.email_address,
        );
        const { messageId, threadId } = await sendGmailMessage(
          accessToken,
          rawMessage,
        );

        sendRail.succeed(`Sent via Gmail           msg: ${messageId}`);

        // Update database
        const now = new Date().toISOString();
        await Promise.all([
          supabase
            .from("campaign_pitch_drafts")
            .update({
              send_status: "sent",
              sent_at: now,
              gmail_message_id: messageId,
              gmail_thread_id: threadId,
              sent_via: "cli",
            })
            .eq("id", pitchId),
          pitch.contact_id && pitch.campaign_id
            ? supabase
                .from("campaign_contacts")
                .update({
                  pitch_status: "sent",
                  last_pitched_at: now,
                })
                .eq("contact_id", pitch.contact_id)
                .eq("project_id", pitch.campaign_id)
            : Promise.resolve(),
          supabase.from("gmail_send_logs").insert({
            workspace_id: wsId,
            user_id: gmailConn!.id,
            campaign_id: pitch.campaign_id,
            contact_id: pitch.contact_id,
            pitch_id: pitchId,
            recipient_email: contact.email,
            subject: pitch.subject,
            gmail_message_id: messageId,
            gmail_thread_id: threadId,
            sent_at: now,
          }),
        ]);

        stepComplete("Status updated           sent");

        // Calculate follow-up date
        const followUp = new Date();
        followUp.setDate(followUp.getDate() + 5);
        stepComplete(
          `Follow-up                ${followUp.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`,
        );

        if (opts.json) {
          out.json({
            sent: true,
            messageId,
            threadId,
            to: contact.email,
            subject: pitch.subject,
          });
        }

        blank();
        summaryBar([
          "Sent",
          `To: ${contact.email}`,
          `Follow-up: ${followUp.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`,
        ]);

        navHint([
          "tap queue",
          `tap contacts history ${contact.id.slice(0, 8)}`,
        ]);
        blank();
      } catch (err) {
        handleError(err);
        process.exit(1);
      }
    });
}
