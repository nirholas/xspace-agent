// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§93]

// =============================================================================
// Stripe Metered Usage Reporter
// Diffs Redis usage counters against last-reported snapshots and pushes
// increments to Stripe subscription item usage records every hour.
// =============================================================================

import Stripe from 'stripe'
import { getAppLogger } from 'xspace-agent'
import type { UsageTracker } from 'xspace-agent'
import type { UsageMetric } from 'xspace-agent'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface StripeUsageReporterConfig {
  tracker: UsageTracker
  /** Interval between reports (ms). Default: 3_600_000 (1 hour). */
  intervalMs?: number
  /**
   * Provide active org IDs at report time.
   * The reporter calls this to get the list of orgs to flush.
   */
  getActiveOrgIds: () => Promise<string[]>
  /**
   * Resolve a Stripe subscription item ID for (orgId, metric).
   * Return null if the metric is not metered for this org.
   */
  getSubscriptionItemId: (orgId: string, metric: UsageMetric) => Promise<string | null>
}

// ---------------------------------------------------------------------------
// Metered metrics eligible for Stripe reporting
// ---------------------------------------------------------------------------

const METERED_METRICS: UsageMetric[] = [
  'session_minutes',
  'stt_minutes',
  'tts_characters',
  'llm_output_tokens',
]

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

export class StripeUsageReporter {
  private stripe: InstanceType<typeof Stripe>
  private log = getAppLogger('stripe-reporter')
  private timer: ReturnType<typeof setInterval> | null = null
  private lastReported: Map<string, number> = new Map()
  private config: Required<StripeUsageReporterConfig>

  constructor(stripeSecretKey: string, config: StripeUsageReporterConfig) {
    this.stripe = new Stripe(stripeSecretKey, { apiVersion: '2026-04-22.dahlia' })
    this.config = {
      intervalMs: config.intervalMs ?? 3_600_000,
      ...config,
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.flush().catch((err) =>
        this.log.error({ err: err?.message }, 'stripe usage flush failed'),
      )
    }, this.config.intervalMs)
    this.timer.unref()
    this.log.info({ intervalMs: this.config.intervalMs }, 'stripe usage reporter started')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Flush accumulated usage deltas for all active orgs. */
  async flush(): Promise<void> {
    const orgIds = await this.config.getActiveOrgIds()
    if (orgIds.length === 0) return

    this.log.debug({ orgCount: orgIds.length }, 'flushing metered usage to stripe')

    const results = await Promise.allSettled(
      orgIds.map((orgId) => this.flushOrg(orgId)),
    )

    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed > 0) {
      this.log.warn({ failed, total: orgIds.length }, 'some orgs failed stripe usage flush')
    }
  }

  private async flushOrg(orgId: string): Promise<void> {
    const summary = await this.config.tracker.getUsageSummary(orgId)

    // Resolve the Stripe customer ID for this org
    const stripeCustomerId = await this.config.getSubscriptionItemId(orgId, 'session_minutes')
    if (!stripeCustomerId) return

    for (const metric of METERED_METRICS) {
      const totalUsed = summary.metrics[metric] ?? 0
      const lastKey = `${orgId}:${metric}:${summary.period}`
      const lastValue = this.lastReported.get(lastKey) ?? 0

      const delta = totalUsed - lastValue
      if (delta <= 0) continue

      try {
        // Stripe v22+ Billing Meters API: event_name matches the meter name in Stripe dashboard
        await this.stripe.billing.meterEvents.create({
          event_name: metric,
          payload: {
            value: String(Math.round(delta)),
            stripe_customer_id: stripeCustomerId,
          },
        })

        this.lastReported.set(lastKey, totalUsed)
        this.log.debug({ orgId, metric, delta }, 'usage reported to stripe')
      } catch (err: any) {
        this.log.warn({ err: err.message, orgId, metric, delta }, 'failed to report usage to stripe')
      }
    }
  }

  /** Reset tracked snapshots at the start of a new billing period. */
  resetPeriod(orgId: string): void {
    for (const metric of METERED_METRICS) {
      // Clear all period keys for this org
      for (const key of this.lastReported.keys()) {
        if (key.startsWith(`${orgId}:`)) {
          this.lastReported.delete(key)
        }
      }
    }
  }
}
