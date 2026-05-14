// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§92]

// =============================================================================
// Stripe Webhook Handler — subscription lifecycle, invoice events, usage alerts
// =============================================================================

import { Router, type Request, type Response } from 'express'
import Stripe from 'stripe'
import { getAppLogger } from 'xspace-agent'
import {
  getOrganization,
  updateOrganizationPlan,
  updateOrganizationStripeIds,
  suspendOrganization,
  reactivateOrganization,
} from 'xspace-agent/dist/tenant'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _stripe: Stripe | null = null
function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set')
    _stripe = new Stripe(key, { apiVersion: '2025-01-27.acacia' })
  }
  return _stripe
}

/** Map a Stripe metadata plan string to our internal tier names. */
function normalizePlan(raw: string | null | undefined): string {
  const valid = ['free', 'developer', 'pro', 'business', 'enterprise']
  return valid.includes(raw ?? '') ? raw! : 'developer'
}

// ---------------------------------------------------------------------------
// Router factory
// NOTE: This route MUST receive the raw request body (Buffer) for Stripe
// signature verification.  Mount it BEFORE express.json() in the server.
// ---------------------------------------------------------------------------

export function createWebhookRouter(): Router {
  const router = Router()
  const log = getAppLogger('webhooks')

  // Stripe sends the signature in this header
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? ''

  if (!WEBHOOK_SECRET) {
    log.warn('STRIPE_WEBHOOK_SECRET is not set — webhook signature verification disabled')
  }

  // ── POST /webhooks/stripe ─────────────────────────────────────────────────
  router.post(
    '/stripe',
    // Parse raw body so we can verify Stripe's signature
    (req, res, next) => {
      // express.raw() is applied at the route level via inline buffer collection
      let data = Buffer.alloc(0)
      req.on('data', (chunk: Buffer) => { data = Buffer.concat([data, chunk]) })
      req.on('end', () => {
        ;(req as any).rawBody = data
        next()
      })
    },
    async (req: Request, res: Response) => {
      const sig = req.headers['stripe-signature'] as string | undefined
      const rawBody: Buffer = (req as any).rawBody

      let event: Stripe.Event

      // Verify signature
      try {
        if (WEBHOOK_SECRET && sig) {
          event = getStripe().webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET)
        } else {
          // Allow unsigned in development; log loudly
          log.warn({ type: (req.body as any)?.type }, 'processing unsigned webhook — set STRIPE_WEBHOOK_SECRET in production')
          event = JSON.parse(rawBody.toString()) as Stripe.Event
        }
      } catch (err: any) {
        log.warn({ err: err.message }, 'webhook signature verification failed')
        res.status(400).json({ error: `Webhook Error: ${err.message}` })
        return
      }

      log.info({ eventType: event.type, eventId: event.id }, 'stripe webhook received')

      try {
        await handleEvent(event, log)
        res.json({ received: true })
      } catch (err: any) {
        log.error({ err: err.message, eventType: event.type }, 'webhook handler threw')
        // Return 200 so Stripe doesn't retry non-transient errors
        res.json({ received: true, warning: err.message })
      }
    },
  )

  return router
}

// ---------------------------------------------------------------------------
// Event dispatcher
// ---------------------------------------------------------------------------

async function handleEvent(event: Stripe.Event, log: ReturnType<typeof getAppLogger>) {
  switch (event.type) {

    // ── Checkout completed — link Stripe customer/subscription to org ────────
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      const orgId   = session.metadata?.orgId
      const plan    = normalizePlan(session.metadata?.plan)

      if (!orgId) { log.warn({ sessionId: session.id }, 'checkout.session.completed missing orgId metadata'); break }

      const customerId     = session.customer as string | null
      const subscriptionId = session.subscription as string | null

      if (customerId || subscriptionId) {
        await updateOrganizationStripeIds(orgId, {
          stripeCustomerId:     customerId     ?? undefined,
          stripeSubscriptionId: subscriptionId ?? undefined,
        })
      }

      await updateOrganizationPlan(orgId, plan)
      log.info({ orgId, plan, customerId, subscriptionId }, 'checkout completed — plan activated')
      break
    }

    // ── Subscription created ─────────────────────────────────────────────────
    case 'customer.subscription.created': {
      const sub  = event.data.object as Stripe.Subscription
      const plan = normalizePlan(sub.metadata?.plan)
      const orgId = sub.metadata?.orgId

      if (!orgId) { log.warn({ subId: sub.id }, 'subscription.created missing orgId metadata'); break }

      await updateOrganizationStripeIds(orgId, { stripeSubscriptionId: sub.id })
      await updateOrganizationPlan(orgId, plan)
      log.info({ orgId, plan, subId: sub.id }, 'subscription created')
      break
    }

    // ── Subscription updated (plan change, trial end, etc.) ──────────────────
    case 'customer.subscription.updated': {
      const sub     = event.data.object as Stripe.Subscription
      const orgId   = sub.metadata?.orgId
      const newPlan = normalizePlan(sub.metadata?.plan)

      if (!orgId) { log.warn({ subId: sub.id }, 'subscription.updated missing orgId metadata'); break }

      // Sync plan if it changed
      const org = getOrganization(orgId)
      if (org && org.plan !== newPlan) {
        await updateOrganizationPlan(orgId, newPlan)
        log.info({ orgId, from: org.plan, to: newPlan }, 'plan updated via subscription change')
      }

      // Handle status transitions
      if (sub.status === 'active' && org?.status === 'suspended') {
        await reactivateOrganization(orgId)
        log.info({ orgId }, 'organization reactivated after payment')
      }

      break
    }

    // ── Subscription deleted (cancelled immediately or after period end) ─────
    case 'customer.subscription.deleted': {
      const sub   = event.data.object as Stripe.Subscription
      const orgId = sub.metadata?.orgId

      if (!orgId) { log.warn({ subId: sub.id }, 'subscription.deleted missing orgId metadata'); break }

      await updateOrganizationPlan(orgId, 'free')
      log.info({ orgId, subId: sub.id }, 'subscription deleted — org downgraded to free')
      break
    }

    // ── Invoice paid — record payment, clear any suspension ─────────────────
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice
      const customerId = invoice.customer as string | null
      if (!customerId) break

      // Resolve org from customer ID
      const org = await resolveOrgByCustomerId(customerId)
      if (!org) { log.warn({ customerId }, 'invoice.paid — could not resolve org'); break }

      if (org.status === 'suspended') {
        await reactivateOrganization(org.id)
        log.info({ orgId: org.id }, 'org reactivated after invoice payment')
      }

      log.info({
        orgId: org.id,
        invoiceId: invoice.id,
        amount: invoice.amount_paid / 100,
        currency: invoice.currency,
      }, 'invoice paid')
      break
    }

    // ── Invoice payment failed — suspend after grace period ──────────────────
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice
      const customerId = invoice.customer as string | null
      if (!customerId) break

      const org = await resolveOrgByCustomerId(customerId)
      if (!org) { log.warn({ customerId }, 'invoice.payment_failed — could not resolve org'); break }

      // Stripe retries automatically; only suspend on final attempt
      const attemptCount = invoice.attempt_count ?? 0
      if (attemptCount >= 3) {
        await suspendOrganization(org.id, 'non_payment')
        log.warn({ orgId: org.id, attemptCount }, 'org suspended after repeated payment failures')
      } else {
        log.warn({ orgId: org.id, attemptCount }, 'invoice payment failed — retries remaining')
      }
      break
    }

    // ── Trial ending soon (3 days out) ────────────────────────────────────────
    case 'customer.subscription.trial_will_end': {
      const sub   = event.data.object as Stripe.Subscription
      const orgId = sub.metadata?.orgId
      if (!orgId) break

      log.info({ orgId, trialEnd: (sub as any).trial_end }, 'trial ending in 3 days — reminder')
      // TODO: Send email reminder via notification service
      break
    }

    default:
      log.debug({ eventType: event.type }, 'unhandled stripe event type')
  }
}

// ---------------------------------------------------------------------------
// Resolve an org from a Stripe customer ID
// ---------------------------------------------------------------------------

async function resolveOrgByCustomerId(customerId: string) {
  // This calls the tenant repo's findByStripeCustomerId stub.
  // The implementation is provided by the tenant layer (DB query).
  try {
    const { findByStripeCustomerId } = await import('xspace-agent/dist/tenant')
    return findByStripeCustomerId(customerId)
  } catch {
    return null
  }
}
