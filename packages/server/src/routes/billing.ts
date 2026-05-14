// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§91]

// =============================================================================
// Billing Routes — Stripe subscriptions, checkout, invoices, customer portal
// =============================================================================

import { Router } from 'express'
import Stripe from 'stripe'
import { getAppLogger } from 'xspace-agent'

// ---------------------------------------------------------------------------
// Stripe client (lazy — only initialised when STRIPE_SECRET_KEY is present)
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

// ---------------------------------------------------------------------------
// Plan → Stripe Price ID mapping (set these in your Stripe dashboard)
// ---------------------------------------------------------------------------

const PLAN_PRICE_IDS: Record<string, string | undefined> = {
  developer: process.env.STRIPE_PRICE_DEVELOPER,
  pro:        process.env.STRIPE_PRICE_PRO,
  business:   process.env.STRIPE_PRICE_BUSINESS,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
}

// Metered price IDs for usage-based billing
const METERED_PRICE_IDS: Partial<Record<string, string>> = {
  session_minutes: process.env.STRIPE_METER_SESSION_MINUTES,
  tts_characters:  process.env.STRIPE_METER_TTS_CHARS,
  stt_minutes:     process.env.STRIPE_METER_STT_MINUTES,
  llm_output_tokens: process.env.STRIPE_METER_LLM_TOKENS,
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createBillingRouter(): Router {
  const router = Router()
  const log = getAppLogger('billing')

  // ── GET /api/billing/subscription ─────────────────────────────────────────
  // Returns the current subscription status for the authenticated tenant.
  router.get('/subscription', async (req, res) => {
    const tenant = (req as any).tenant
    if (!tenant) { res.status(401).json({ error: 'Tenant context required' }); return }

    const stripeCustomerId = tenant.org.stripeCustomerId as string | undefined
    if (!stripeCustomerId) {
      res.json({
        status: 'none',
        plan: tenant.plan.tier,
        hint: 'No billing account yet. Call POST /api/billing/checkout to subscribe.',
      })
      return
    }

    try {
      const stripe = getStripe()
      const subscriptions = await stripe.subscriptions.list({
        customer: stripeCustomerId,
        status: 'all',
        limit: 1,
        expand: ['data.default_payment_method', 'data.latest_invoice'],
      })

      const sub = subscriptions.data[0]
      if (!sub) {
        res.json({ status: 'none', plan: tenant.plan.tier })
        return
      }

      res.json({
        id: sub.id,
        status: sub.status,
        plan: tenant.plan.tier,
        currentPeriodStart: new Date((sub as any).current_period_start * 1000).toISOString(),
        currentPeriodEnd:   new Date((sub as any).current_period_end   * 1000).toISOString(),
        cancelAtPeriodEnd:  sub.cancel_at_period_end,
        cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
        trialEnd: (sub as any).trial_end ? new Date((sub as any).trial_end * 1000).toISOString() : null,
        defaultPaymentMethod: sub.default_payment_method,
        latestInvoice: sub.latest_invoice,
      })
    } catch (err: any) {
      log.error({ err: err.message }, 'failed to fetch subscription')
      res.status(500).json({ error: 'Failed to fetch subscription', detail: err.message })
    }
  })

  // ── POST /api/billing/checkout ────────────────────────────────────────────
  // Create a Stripe Checkout session to start or upgrade a subscription.
  // Body: { plan: 'developer' | 'pro' | 'business' | 'enterprise', successUrl, cancelUrl }
  router.post('/checkout', async (req, res) => {
    const tenant = (req as any).tenant
    if (!tenant) { res.status(401).json({ error: 'Tenant context required' }); return }

    const { plan, successUrl, cancelUrl } = req.body as {
      plan?: string
      successUrl?: string
      cancelUrl?: string
    }

    if (!plan || !PLAN_PRICE_IDS[plan]) {
      res.status(400).json({
        error: 'Invalid plan',
        available: Object.keys(PLAN_PRICE_IDS),
      })
      return
    }

    if (plan === 'enterprise') {
      res.status(400).json({
        error: 'Enterprise plans require a custom quote. Contact sales@xspaceagent.com',
      })
      return
    }

    const priceId = PLAN_PRICE_IDS[plan]!
    const appUrl = process.env.APP_URL || 'https://app.xspaceagent.com'

    try {
      const stripe = getStripe()
      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [
          { price: priceId, quantity: 1 },
          // Append metered add-ons (quantity-less)
          ...Object.values(METERED_PRICE_IDS)
            .filter(Boolean)
            .map((meteredPrice) => ({ price: meteredPrice! })),
        ],
        success_url: successUrl ?? `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  cancelUrl  ?? `${appUrl}/billing/cancel`,
        metadata: {
          orgId: tenant.orgId,
          plan,
        },
        subscription_data: {
          metadata: { orgId: tenant.orgId, plan },
          trial_period_days: plan === 'developer' ? 14 : undefined,
        },
      }

      // Attach existing customer if known, otherwise collect email
      const stripeCustomerId = tenant.org.stripeCustomerId as string | undefined
      if (stripeCustomerId) {
        sessionParams.customer = stripeCustomerId
        sessionParams.customer_update = { address: 'auto' }
      } else {
        sessionParams.customer_email = tenant.org.billingEmail ?? tenant.org.ownerEmail ?? undefined
      }

      const session = await stripe.checkout.sessions.create(sessionParams)
      log.info({ orgId: tenant.orgId, plan, sessionId: session.id }, 'checkout session created')

      res.json({ url: session.url, sessionId: session.id })
    } catch (err: any) {
      log.error({ err: err.message, orgId: tenant.orgId }, 'checkout session creation failed')
      res.status(500).json({ error: 'Failed to create checkout session', detail: err.message })
    }
  })

  // ── POST /api/billing/portal ──────────────────────────────────────────────
  // Create a Stripe Customer Portal session for managing billing.
  router.post('/portal', async (req, res) => {
    const tenant = (req as any).tenant
    if (!tenant) { res.status(401).json({ error: 'Tenant context required' }); return }

    const stripeCustomerId = tenant.org.stripeCustomerId as string | undefined
    if (!stripeCustomerId) {
      res.status(400).json({
        error: 'No billing account found. Subscribe first via POST /api/billing/checkout',
      })
      return
    }

    const appUrl = process.env.APP_URL || 'https://app.xspaceagent.com'
    const { returnUrl } = req.body as { returnUrl?: string }

    try {
      const stripe = getStripe()
      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: returnUrl ?? `${appUrl}/settings/billing`,
      })

      log.info({ orgId: tenant.orgId }, 'billing portal session created')
      res.json({ url: session.url })
    } catch (err: any) {
      log.error({ err: err.message, orgId: tenant.orgId }, 'portal session creation failed')
      res.status(500).json({ error: 'Failed to create portal session', detail: err.message })
    }
  })

  // ── GET /api/billing/invoices ─────────────────────────────────────────────
  // List the most recent invoices for the tenant.
  router.get('/invoices', async (req, res) => {
    const tenant = (req as any).tenant
    if (!tenant) { res.status(401).json({ error: 'Tenant context required' }); return }

    const stripeCustomerId = tenant.org.stripeCustomerId as string | undefined
    if (!stripeCustomerId) { res.json({ invoices: [] }); return }

    const limit = Math.min(parseInt((req.query.limit as string) || '12', 10), 50)

    try {
      const stripe = getStripe()
      const invoices = await stripe.invoices.list({
        customer: stripeCustomerId,
        limit,
        expand: ['data.charge'],
      })

      res.json({
        invoices: invoices.data.map((inv) => ({
          id: inv.id,
          number: inv.number,
          status: inv.status,
          amountDue:  inv.amount_due  / 100,
          amountPaid: inv.amount_paid / 100,
          currency: inv.currency.toUpperCase(),
          periodStart: new Date(inv.period_start * 1000).toISOString(),
          periodEnd:   new Date(inv.period_end   * 1000).toISOString(),
          createdAt: new Date(inv.created * 1000).toISOString(),
          pdfUrl: inv.invoice_pdf,
          hostedUrl: inv.hosted_invoice_url,
        })),
        hasMore: invoices.has_more,
      })
    } catch (err: any) {
      log.error({ err: err.message, orgId: tenant.orgId }, 'failed to list invoices')
      res.status(500).json({ error: 'Failed to list invoices', detail: err.message })
    }
  })

  // ── POST /api/billing/cancel ──────────────────────────────────────────────
  // Cancel the active subscription at period end.
  router.post('/cancel', async (req, res) => {
    const tenant = (req as any).tenant
    if (!tenant) { res.status(401).json({ error: 'Tenant context required' }); return }

    const stripeCustomerId = tenant.org.stripeCustomerId as string | undefined
    if (!stripeCustomerId) {
      res.status(400).json({ error: 'No billing account found' })
      return
    }

    const { immediately = false } = req.body as { immediately?: boolean }

    try {
      const stripe = getStripe()
      const subscriptions = await stripe.subscriptions.list({
        customer: stripeCustomerId,
        status: 'active',
        limit: 1,
      })

      const sub = subscriptions.data[0]
      if (!sub) {
        res.status(404).json({ error: 'No active subscription found' })
        return
      }

      let result: Stripe.Subscription
      if (immediately) {
        result = await stripe.subscriptions.cancel(sub.id)
      } else {
        result = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true })
      }

      log.info({ orgId: tenant.orgId, subId: sub.id, immediately }, 'subscription cancelled')
      res.json({
        cancelled: true,
        immediately,
        cancelAt: result.cancel_at ? new Date(result.cancel_at * 1000).toISOString() : null,
        currentPeriodEnd: new Date((result as any).current_period_end * 1000).toISOString(),
      })
    } catch (err: any) {
      log.error({ err: err.message, orgId: tenant.orgId }, 'subscription cancellation failed')
      res.status(500).json({ error: 'Failed to cancel subscription', detail: err.message })
    }
  })

  // ── PUT /api/billing/plan ─────────────────────────────────────────────────
  // Upgrade or downgrade the subscription to a different plan immediately.
  router.put('/plan', async (req, res) => {
    const tenant = (req as any).tenant
    if (!tenant) { res.status(401).json({ error: 'Tenant context required' }); return }

    const { plan } = req.body as { plan?: string }
    if (!plan || !PLAN_PRICE_IDS[plan]) {
      res.status(400).json({ error: 'Invalid plan', available: Object.keys(PLAN_PRICE_IDS) })
      return
    }

    if (plan === 'enterprise') {
      res.status(400).json({ error: 'Contact sales@xspaceagent.com for enterprise' })
      return
    }

    const stripeCustomerId = tenant.org.stripeCustomerId as string | undefined
    if (!stripeCustomerId) {
      res.status(400).json({ error: 'No billing account. Use POST /api/billing/checkout first.' })
      return
    }

    try {
      const stripe = getStripe()
      const subscriptions = await stripe.subscriptions.list({
        customer: stripeCustomerId,
        status: 'active',
        limit: 1,
        expand: ['data.items'],
      })

      const sub = subscriptions.data[0]
      if (!sub) {
        res.status(404).json({ error: 'No active subscription found' })
        return
      }

      // Find the base plan item (non-metered)
      const baseItem = (sub.items.data as Stripe.SubscriptionItem[]).find(
        (item) => !(item.price as any).recurring?.usage_type || (item.price as any).recurring.usage_type === 'licensed',
      )
      if (!baseItem) {
        res.status(500).json({ error: 'Could not identify base plan item in subscription' })
        return
      }

      const updated = await stripe.subscriptions.update(sub.id, {
        items: [{ id: baseItem.id, price: PLAN_PRICE_IDS[plan]! }],
        proration_behavior: 'create_prorations',
        metadata: { plan },
      })

      log.info({ orgId: tenant.orgId, from: tenant.plan.tier, to: plan }, 'plan changed')
      res.json({
        success: true,
        from: tenant.plan.tier,
        to: plan,
        subscriptionId: updated.id,
        currentPeriodEnd: new Date((updated as any).current_period_end * 1000).toISOString(),
      })
    } catch (err: any) {
      log.error({ err: err.message, orgId: tenant.orgId }, 'plan change failed')
      res.status(500).json({ error: 'Failed to change plan', detail: err.message })
    }
  })

  // ── GET /api/billing/payment-methods ─────────────────────────────────────
  router.get('/payment-methods', async (req, res) => {
    const tenant = (req as any).tenant
    if (!tenant) { res.status(401).json({ error: 'Tenant context required' }); return }

    const stripeCustomerId = tenant.org.stripeCustomerId as string | undefined
    if (!stripeCustomerId) { res.json({ paymentMethods: [] }); return }

    try {
      const stripe = getStripe()
      const methods = await stripe.paymentMethods.list({
        customer: stripeCustomerId,
        type: 'card',
      })

      const customer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer
      const defaultMethodId = (customer.invoice_settings?.default_payment_method as string) ?? null

      res.json({
        paymentMethods: methods.data.map((pm) => ({
          id: pm.id,
          brand: pm.card?.brand,
          last4: pm.card?.last4,
          expMonth: pm.card?.exp_month,
          expYear: pm.card?.exp_year,
          isDefault: pm.id === defaultMethodId,
        })),
      })
    } catch (err: any) {
      log.error({ err: err.message, orgId: tenant.orgId }, 'failed to list payment methods')
      res.status(500).json({ error: 'Failed to list payment methods', detail: err.message })
    }
  })

  // ── POST /api/billing/usage/report ───────────────────────────────────────
  // Manually report metered usage to Stripe (normally done automatically by usage-tracker).
  router.post('/usage/report', async (req, res) => {
    const tenant = (req as any).tenant
    if (!tenant) { res.status(401).json({ error: 'Tenant context required' }); return }

    const { metric, quantity } = req.body as { metric?: string; quantity?: number }
    if (!metric || typeof quantity !== 'number' || quantity < 0) {
      res.status(400).json({ error: 'metric (string) and quantity (number >= 0) required' })
      return
    }

    const meterId = METERED_PRICE_IDS[metric]
    if (!meterId) {
      res.status(400).json({
        error: `Unknown metered metric: ${metric}`,
        available: Object.keys(METERED_PRICE_IDS),
      })
      return
    }

    const stripeCustomerId = tenant.org.stripeCustomerId as string | undefined
    if (!stripeCustomerId) {
      res.status(400).json({ error: 'No billing account found' })
      return
    }

    try {
      const stripe = getStripe()
      const subscriptions = await stripe.subscriptions.list({
        customer: stripeCustomerId,
        status: 'active',
        limit: 1,
        expand: ['data.items'],
      })

      const sub = subscriptions.data[0]
      if (!sub) { res.status(404).json({ error: 'No active subscription' }); return }

      const meteredItem = (sub.items.data as Stripe.SubscriptionItem[]).find(
        (item) => item.price.id === meterId,
      )
      if (!meteredItem) {
        res.status(404).json({ error: `No metered item for ${metric} in subscription` })
        return
      }

      await stripe.subscriptionItems.createUsageRecord(meteredItem.id, {
        quantity: Math.round(quantity),
        timestamp: Math.floor(Date.now() / 1000),
        action: 'increment',
      })

      log.info({ orgId: tenant.orgId, metric, quantity }, 'usage reported to Stripe')
      res.json({ success: true, metric, quantity })
    } catch (err: any) {
      log.error({ err: err.message, orgId: tenant.orgId }, 'failed to report usage to Stripe')
      res.status(500).json({ error: 'Failed to report usage', detail: err.message })
    }
  })

  return router
}
