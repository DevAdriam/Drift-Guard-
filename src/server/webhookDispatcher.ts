import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { alertWebhooks } from '../db/schema.ts';
import { decryptSecret, validateSafeWebhookUrl } from './crypto.ts';
import { isInActiveMaintenanceWindow } from './governanceService.ts';
import type {
  IncidentDetails,
  IncidentType,
  SeverityLevel,
  WebhookProvider,
} from '../types/telemetry.ts';

const SEVERITY_RANK: Record<SeverityLevel, number> = {
  INFO: 1,
  WARNING: 2,
  CRITICAL: 3,
};

export interface AlertDispatchPayload {
  databaseId?: string;
  databaseName: string;
  environment: string;
  incidentType: IncidentType;
  severity: SeverityLevel;
  summary: string;
  details: IncidentDetails;
  timestamp: string;
}

function buildProviderPayload(
  provider: WebhookProvider,
  alert: AlertDispatchPayload
): Record<string, unknown> {
  const severityColor =
    alert.severity === 'CRITICAL'
      ? 0xdc2626
      : alert.severity === 'WARNING'
        ? 0xd97706
        : 0x2563eb;

  const title = `[${alert.severity}] ${alert.incidentType} on ${alert.databaseName} (${alert.environment})`;

  if (provider === 'slack') {
    return {
      text: `${title} — ${alert.summary}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: title.slice(0, 150),
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Summary:* ${alert.summary}\n*Environment:* \`${alert.environment}\`\n*Detected:* ${alert.timestamp}`,
          },
        },
      ],
    };
  }

  if (provider === 'discord') {
    return {
      content: title,
      embeds: [
        {
          title: `${alert.incidentType} · ${alert.databaseName}`,
          description: alert.summary,
          color: severityColor,
          fields: [
            { name: 'Severity', value: alert.severity, inline: true },
            { name: 'Environment', value: alert.environment, inline: true },
          ],
          timestamp: alert.timestamp,
        },
      ],
    };
  }

  return {
    event: 'driftguard.incident',
    ...alert,
  };
}

export async function dispatchIncidentAlerts(
  ownerUid: string,
  alert: AlertDispatchPayload
): Promise<{ delivered: number; failed: number; suppressed?: boolean }> {
  // Respect active Maintenance Windows configured for this environment or target
  const silenceCheck = await isInActiveMaintenanceWindow(ownerUid, {
    databaseId: alert.databaseId ?? null,
    environment: alert.environment,
    checkType: 'webhook',
  });
  if (silenceCheck.suppressed) {
    return { delivered: 0, failed: 0, suppressed: true };
  }

  let channels: (typeof alertWebhooks.$inferSelect)[];
  try {
    channels = await db
      .select()
      .from(alertWebhooks)
      .where(
        and(eq(alertWebhooks.ownerUid, ownerUid), eq(alertWebhooks.isActive, true))
      );
  } catch (error) {
    console.error('Failed to query alert webhooks:', error);
    return { delivered: 0, failed: 0 };
  }

  const eligible = channels.filter(
    (ch) =>
      SEVERITY_RANK[alert.severity] >=
      SEVERITY_RANK[(ch.minSeverity as SeverityLevel) || 'WARNING']
  );

  let delivered = 0;
  let failed = 0;

  await Promise.all(
    eligible.map(async (channel) => {
      try {
        const rawUrl = decryptSecret(channel.webhookUrlEncrypted);
        const provider = channel.provider as WebhookProvider;
        const safeUrl = await validateSafeWebhookUrl(rawUrl, provider);
        const payload = buildProviderPayload(provider, alert);

        const response = await fetch(safeUrl.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        });

        await db
          .update(alertWebhooks)
          .set({
            lastTriggeredAt: new Date(),
            lastStatusCode: response.status,
          })
          .where(eq(alertWebhooks.id, channel.id));

        if (response.ok) {
          delivered += 1;
        } else {
          failed += 1;
        }
      } catch (error) {
        console.error(`Webhook dispatch failed for channel ${channel.id}:`, error);
        failed += 1;
        await db
          .update(alertWebhooks)
          .set({
            lastTriggeredAt: new Date(),
            lastStatusCode: 0,
          })
          .where(eq(alertWebhooks.id, channel.id))
          .catch(() => undefined);
      }
    })
  );

  return { delivered, failed };
}

export async function sendTestWebhookChannel(
  ownerUid: string,
  webhookId: string
): Promise<{ ok: boolean; statusCode: number; message: string }> {
  const rows = await db
    .select()
    .from(alertWebhooks)
    .where(
      and(eq(alertWebhooks.id, webhookId), eq(alertWebhooks.ownerUid, ownerUid))
    )
    .limit(1);

  if (!rows.length) {
    throw new Error('Webhook channel not found.');
  }

  const channel = rows[0];
  const rawUrl = decryptSecret(channel.webhookUrlEncrypted);
  const provider = channel.provider as WebhookProvider;
  const safeUrl = await validateSafeWebhookUrl(rawUrl, provider);

  const payload = buildProviderPayload(provider, {
    databaseName: 'driftguard-test-target',
    environment: 'staging',
    incidentType: 'SCHEMA_DRIFT',
    severity: 'INFO',
    summary: 'Verification ping from DriftGuard PostgreSQL Schema Monitor.',
    details: {
      summary: 'Test alert delivery verified.',
      baseline_hash: '0000000000000000',
      live_hash: '0000000000000000',
      git_commit_sha: null,
      added_count: 0,
      removed_count: 0,
      modified_count: 0,
      diffs: [],
    },
    timestamp: new Date().toISOString(),
  });

  try {
    const response = await fetch(safeUrl.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });

    await db
      .update(alertWebhooks)
      .set({
        lastTriggeredAt: new Date(),
        lastStatusCode: response.status,
      })
      .where(eq(alertWebhooks.id, channel.id));

    return {
      ok: response.ok,
      statusCode: response.status,
      message: response.ok
        ? `Delivered successfully (HTTP ${response.status}).`
        : `Endpoint returned HTTP ${response.status}.`,
    };
  } catch (error) {
    await db
      .update(alertWebhooks)
      .set({
        lastTriggeredAt: new Date(),
        lastStatusCode: 0,
      })
      .where(eq(alertWebhooks.id, channel.id))
      .catch(() => undefined);

    throw new Error(
      error instanceof Error ? error.message : 'Failed to reach webhook endpoint.'
    );
  }
}
