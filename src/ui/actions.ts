/**
 * Shared action helpers -- reusable interactive flows that any screen can call.
 *
 * All functions use @clack/prompts, handle cancellation, and return to caller.
 */

import * as prompts from "@clack/prompts";
import chalk from "chalk";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as out from "../output.js";
import { GLYPH } from "./theme.js";
import { blank } from "./format.js";
import {
  VALID_OUTCOME_TYPES,
  mapOutcomeToStatuses,
  type OutcomeType,
} from "../lib/outcome-mapping.js";

/**
 * Select a campaign from the workspace.
 * Returns campaign ID or null if cancelled.
 */
export async function selectCampaign(
  supabase: SupabaseClient,
  wsId: string,
  opts?: { statusFilter?: string; message?: string },
): Promise<string | null> {
  const spinner = out.spinner("Loading campaigns...");

  let query = supabase
    .from("tap_projects")
    .select("id, name, artist_name, status")
    .eq("workspace_id", wsId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (opts?.statusFilter) query = query.eq("status", opts.statusFilter);

  const { data, error } = await query;
  spinner.stop();

  if (error || !data || data.length === 0) {
    if (error) out.error(error.message);
    else out.info("No campaigns found");
    return null;
  }

  const selected = await prompts.select({
    message: opts?.message || "Select campaign",
    options: [
      ...data.map((c) => ({
        value: c.id as string,
        label: c.artist_name ? `${c.artist_name} -- ${c.name}` : c.name,
        hint: c.status,
      })),
      { value: "__back__" as string, label: chalk.dim("Cancel") },
    ],
  });

  if (prompts.isCancel(selected) || selected === "__back__") return null;
  return selected as string;
}

/**
 * Select a contact from a campaign.
 * Returns contact ID or null if cancelled.
 */
export async function selectCampaignContact(
  supabase: SupabaseClient,
  campaignId: string,
  opts?: { statusFilter?: string; message?: string; limit?: number },
): Promise<string | null> {
  const spinner = out.spinner("Loading contacts...");

  let query = supabase
    .from("campaign_contacts")
    .select("contact_id, pitch_status")
    .eq("project_id", campaignId);

  if (opts?.statusFilter) query = query.eq("pitch_status", opts.statusFilter);

  const { data: cc } = await query.limit(opts?.limit || 20);

  if (!cc || cc.length === 0) {
    spinner.stop();
    out.info("No matching contacts in this campaign");
    return null;
  }

  const contactIds = cc.map((c) => c.contact_id);
  const [contactResult, metricsResult] = await Promise.all([
    supabase
      .from("tap_contacts")
      .select("id, name, email, outlet")
      .in("id", contactIds),
    supabase
      .from("contact_relationship_metrics")
      .select("contact_id, warmth_level")
      .in("contact_id", contactIds),
  ]);

  spinner.stop();

  const contacts = contactResult.data || [];
  const warmthMap = new Map(
    (metricsResult.data || []).map((m) => [m.contact_id, m.warmth_level]),
  );
  const statusMap = new Map(cc.map((c) => [c.contact_id, c.pitch_status]));

  // Sort: hot first, then warm, then rest
  const warmthOrder: Record<string, number> = { hot: 0, warm: 1, neutral: 2, cold: 3 };
  contacts.sort((a, b) => {
    const aW = warmthOrder[warmthMap.get(a.id) || ""] ?? 4;
    const bW = warmthOrder[warmthMap.get(b.id) || ""] ?? 4;
    return aW - bW;
  });

  const selected = await prompts.select({
    message: opts?.message || "Select contact",
    options: [
      ...contacts.map((c) => {
        const warmth = warmthMap.get(c.id);
        const status = statusMap.get(c.id);
        const hints = [c.outlet, warmth, status].filter(Boolean);
        return {
          value: c.id as string,
          label: c.name || c.email,
          hint: hints.join(` ${chalk.dim(GLYPH.dot)} `) || undefined,
        };
      }),
      { value: "__back__" as string, label: chalk.dim("Cancel") },
    ],
  });

  if (prompts.isCancel(selected) || selected === "__back__") return null;
  return selected as string;
}

/**
 * Interactive outcome logging -- prompts for type and notes.
 */
export async function outcomePrompt(
  supabase: SupabaseClient,
  wsId: string,
  campaignId: string,
  contactId: string,
): Promise<boolean> {
  const outcomeType = await prompts.select({
    message: "Outcome type",
    options: VALID_OUTCOME_TYPES.map((t) => ({
      value: t as string,
      label: t.replace(/_/g, " "),
    })),
  });

  if (prompts.isCancel(outcomeType)) return false;

  const notes = await prompts.text({
    message: "Notes (optional)",
    placeholder: "e.g. Loved the track, wants exclusive",
  });

  if (prompts.isCancel(notes)) return false;

  const spinner = out.spinner("Logging outcome...").start();
  const statuses = mapOutcomeToStatuses(outcomeType as OutcomeType);

  const { error } = await supabase
    .from("tap_contact_outcomes")
    .insert({
      workspace_id: wsId,
      project_id: campaignId,
      contact_id: contactId,
      outcome_type: outcomeType,
      notes: (notes as string) || null,
    });

  if (error) {
    spinner.stop();
    out.error(error.message);
    return false;
  }

  // Update statuses
  const updates: PromiseLike<unknown>[] = [];
  if (statuses.pitchStatus) {
    updates.push(
      supabase
        .from("campaign_contacts")
        .update({ pitch_status: statuses.pitchStatus })
        .eq("project_id", campaignId)
        .eq("contact_id", contactId),
    );
  }
  if (statuses.pipelineStatus) {
    updates.push(
      supabase
        .from("tap_contacts")
        .update({ pipeline_status: statuses.pipelineStatus })
        .eq("id", contactId),
    );
  }
  if (updates.length > 0) await Promise.all(updates);

  spinner.stop();
  out.success(`Outcome logged: ${outcomeType}`);
  if (statuses.pitchStatus) {
    out.info(`Pitch status ${out.pitchStatusBadge(statuses.pitchStatus)}`);
  }
  return true;
}

/**
 * Contact action menu -- pitch, outcome, enrich, view, open.
 * Returns the action taken so callers can react.
 */
export async function contactActionMenu(
  supabase: SupabaseClient,
  wsId: string,
  contactId: string,
  opts?: { campaignId?: string; showHistory?: boolean },
): Promise<"pitch" | "outcome" | "enrich" | "history" | "open" | "back"> {
  const options: Array<{ value: string; label: string; hint?: string }> = [];

  options.push({ value: "pitch", label: "Generate pitch", hint: "AI draft" });
  options.push({ value: "outcome", label: "Log outcome" });
  options.push({ value: "enrich", label: "Enrich contact", hint: "queue AI enrichment" });

  if (opts?.showHistory !== false) {
    options.push({ value: "history", label: "View history" });
  }

  options.push({ value: "open", label: "Open in TAP" });
  options.push({ value: "back", label: chalk.dim("Back") });

  const action = await prompts.select({
    message: "What next?",
    options,
  });

  if (prompts.isCancel(action)) return "back";

  switch (action) {
    case "pitch": {
      // Need a campaign context for pitching
      let campaignId = opts?.campaignId;
      if (!campaignId) {
        campaignId = await selectCampaign(supabase, wsId, {
          statusFilter: "active",
          message: "Which campaign?",
        }) || undefined;
        if (!campaignId) return "back";
      }

      // Run pitch command programmatically
      blank();
      try {
        const { buildProgram } = await import("../cli.js");
        const program = buildProgram();
        program.exitOverride();
        program.configureOutput({ writeErr: () => {} });
        await program.parseAsync(["node", "tap", "pitch", campaignId, contactId]);
      } catch {
        // Commander throws on exitOverride
      }
      return "pitch";
    }

    case "outcome": {
      let campaignId = opts?.campaignId;
      if (!campaignId) {
        campaignId = await selectCampaign(supabase, wsId, {
          message: "Which campaign?",
        }) || undefined;
        if (!campaignId) return "back";
      }
      blank();
      await outcomePrompt(supabase, wsId, campaignId, contactId);
      return "outcome";
    }

    case "enrich": {
      const spinner = out.spinner("Queueing enrichment...").start();
      const { error } = await supabase
        .from("tap_contacts")
        .update({ enrichment_source: "queued" })
        .eq("id", contactId);
      spinner.stop();

      if (error) {
        out.error(error.message);
      } else {
        out.success(`Contact ${contactId.slice(0, 8)} queued for enrichment`);
      }
      return "enrich";
    }

    case "history": {
      blank();
      const { showHistory } = await import("../commands/contacts.js");
      await showHistory(contactId, {});
      return "history";
    }

    case "open": {
      try {
        const { buildProgram } = await import("../cli.js");
        const program = buildProgram();
        program.exitOverride();
        program.configureOutput({ writeErr: () => {} });
        await program.parseAsync(["node", "tap", "open", contactId.slice(0, 8)]);
      } catch {
        // Commander throws on exitOverride
      }
      return "open";
    }

    default:
      return "back";
  }
}

/**
 * Campaign action menu -- pitch a contact, change status, log outcome, view.
 */
export async function campaignActionMenu(
  supabase: SupabaseClient,
  wsId: string,
  campaignId: string,
): Promise<"pitch" | "status" | "outcome" | "contacts" | "open" | "back"> {
  const action = await prompts.select({
    message: "What next?",
    options: [
      { value: "pitch" as const, label: "Pitch a contact", hint: "select unpitched" },
      { value: "outcome" as const, label: "Log outcome", hint: "select contact" },
      { value: "status" as const, label: "Change status" },
      { value: "contacts" as const, label: "View contacts" },
      { value: "open" as const, label: "Open in TAP" },
      { value: "back" as const, label: chalk.dim("Back") },
    ],
  });

  if (prompts.isCancel(action)) return "back";

  switch (action) {
    case "pitch": {
      blank();
      try {
        const { buildProgram } = await import("../cli.js");
        const program = buildProgram();
        program.exitOverride();
        program.configureOutput({ writeErr: () => {} });
        await program.parseAsync(["node", "tap", "pitch", campaignId]);
      } catch {
        // Commander throws on exitOverride
      }
      return "pitch";
    }

    case "outcome": {
      const contactId = await selectCampaignContact(supabase, campaignId, {
        message: "Select contact for outcome",
      });
      if (!contactId) return "back";
      blank();
      await outcomePrompt(supabase, wsId, campaignId, contactId);
      return "outcome";
    }

    case "status": {
      const status = await prompts.select({
        message: "New status",
        options: [
          { value: "draft", label: "Draft" },
          { value: "active", label: "Active" },
          { value: "paused", label: "Paused" },
          { value: "completed", label: "Completed" },
          { value: "archived", label: "Archived" },
        ],
      });

      if (prompts.isCancel(status)) return "back";

      const spinner = out.spinner("Updating status...").start();
      const { error } = await supabase
        .from("tap_projects")
        .update({ status })
        .eq("id", campaignId);
      spinner.stop();

      if (error) {
        out.error(error.message);
      } else {
        out.success(`Campaign ${campaignId.slice(0, 8)} ${GLYPH.arrow} ${out.statusBadge(status as string)}`);
      }
      return "status";
    }

    case "contacts": {
      blank();
      try {
        const { buildProgram } = await import("../cli.js");
        const program = buildProgram();
        program.exitOverride();
        program.configureOutput({ writeErr: () => {} });
        await program.parseAsync(["node", "tap", "campaigns", "show", campaignId]);
      } catch {
        // Commander throws on exitOverride
      }
      return "contacts";
    }

    case "open": {
      try {
        const { buildProgram } = await import("../cli.js");
        const program = buildProgram();
        program.exitOverride();
        program.configureOutput({ writeErr: () => {} });
        await program.parseAsync(["node", "tap", "open", campaignId.slice(0, 8)]);
      } catch {
        // Commander throws on exitOverride
      }
      return "open";
    }

    default:
      return "back";
  }
}
