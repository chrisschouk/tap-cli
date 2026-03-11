/**
 * Gmail send logic for tap-cli.
 *
 * Reads OAuth tokens from the gmail_connections table (same tokens
 * the TAP web UI uses). Refreshes tokens when expired.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

interface GmailConnection {
  id: string;
  email_address: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
}

/**
 * Get the active Gmail connection for a workspace.
 */
export async function getGmailConnection(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<GmailConnection | null> {
  const { data, error } = await supabase
    .from("gmail_connections")
    .select("id, email_address, access_token, refresh_token, token_expires_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data as GmailConnection;
}

/**
 * Refresh Gmail OAuth token if it expires within 5 minutes.
 * Returns the (possibly refreshed) access token.
 */
export async function ensureFreshToken(
  supabase: SupabaseClient,
  connection: GmailConnection,
): Promise<string> {
  const expiresAt = new Date(connection.token_expires_at).getTime();
  const fiveMinBuffer = 5 * 60 * 1000;

  if (Date.now() < expiresAt - fiveMinBuffer) {
    return connection.access_token;
  }

  // Need to refresh
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET required for token refresh. " +
        "Set them in environment or ~/.tap/config.json",
    );
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: connection.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${response.statusText}`);
  }

  const tokens = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // Update in database
  await supabase
    .from("gmail_connections")
    .update({
      access_token: tokens.access_token,
      token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connection.id);

  return tokens.access_token;
}

/**
 * Build an RFC 2822 MIME message and base64url-encode it.
 */
export function buildRawMessage(
  to: string,
  subject: string,
  body: string,
  from?: string,
): string {
  const headers = [
    `From: ${from || "me"}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
  ].join("\r\n");

  const message = `${headers}\r\n\r\n${body}`;
  const encoded = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return encoded;
}

/**
 * Send a message via Gmail API.
 * Returns the Gmail message ID and thread ID.
 */
export async function sendGmailMessage(
  accessToken: string,
  rawMessage: string,
): Promise<{ messageId: string; threadId: string }> {
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: rawMessage }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gmail send failed: ${response.status} ${errorText}`);
  }

  const result = (await response.json()) as { id: string; threadId: string };
  return { messageId: result.id, threadId: result.threadId };
}

/**
 * Check daily send count to enforce rate limit.
 */
export async function getDailySendCount(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from("gmail_send_logs")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .gte("sent_at", today.toISOString());

  return count || 0;
}
