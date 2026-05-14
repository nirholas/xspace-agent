// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§95]

// =============================================================================
// GCP Secret Manager Implementation
// Stores per-tenant secrets in Google Cloud Secret Manager.
// Secret names follow the convention: xspace-<orgId>-<key>
// =============================================================================

import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import { getAppLogger } from '../observability/logger'
import type { SecretsManager } from './secrets-manager'

const log = getAppLogger('secrets-gcp')

export interface GCPSecretsManagerConfig {
  projectId: string
}

export class GCPSecretsManager implements SecretsManager {
  private client: SecretManagerServiceClient
  private projectId: string

  constructor(config: GCPSecretsManagerConfig) {
    this.client = new SecretManagerServiceClient()
    this.projectId = config.projectId
  }

  private secretName(orgId: string, key: string): string {
    // Secret IDs: alphanumeric + hyphens/underscores only, max 255 chars
    const safeOrg = orgId.replace(/[^a-zA-Z0-9_-]/g, '-')
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '-')
    return `xspace-${safeOrg}-${safeKey}`
  }

  private secretParent(): string {
    return `projects/${this.projectId}`
  }

  private secretFullName(orgId: string, key: string): string {
    return `${this.secretParent()}/secrets/${this.secretName(orgId, key)}`
  }

  // ── Get ───────────────────────────────────────────────────────────────────

  async get(orgId: string, key: string): Promise<string | undefined> {
    const versionName = `${this.secretFullName(orgId, key)}/versions/latest`
    try {
      const [version] = await this.client.accessSecretVersion({ name: versionName })
      const payload = version.payload?.data
      if (!payload) return undefined
      return Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)
    } catch (err: any) {
      // 5 = NOT_FOUND
      if (err.code === 5) return undefined
      log.error({ err: err.message, orgId, key }, 'failed to get secret')
      throw err
    }
  }

  // ── Set (create or update) ────────────────────────────────────────────────

  async set(orgId: string, key: string, value: string): Promise<void> {
    const secretId = this.secretName(orgId, key)
    const parent   = this.secretParent()
    const payload  = { data: Buffer.from(value, 'utf8') }

    // Upsert: try to add a version; create the secret first if it doesn't exist
    try {
      await this.client.addSecretVersion({
        parent: `${parent}/secrets/${secretId}`,
        payload,
      })
    } catch (err: any) {
      if (err.code !== 5) throw err // NOT_FOUND expected on first write

      // Create the secret, then add the version
      await this.client.createSecret({
        parent,
        secretId,
        secret: {
          replication: { automatic: {} },
          labels: {
            'xspace-org': orgId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32),
            'managed-by': 'xspace-platform',
          },
        },
      })

      await this.client.addSecretVersion({
        parent: `${parent}/secrets/${secretId}`,
        payload,
      })
    }

    log.debug({ orgId, key }, 'secret written')
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async delete(orgId: string, key: string): Promise<void> {
    try {
      await this.client.deleteSecret({
        name: this.secretFullName(orgId, key),
      })
      log.debug({ orgId, key }, 'secret deleted')
    } catch (err: any) {
      if (err.code === 5) return // Already doesn't exist
      throw err
    }
  }

  // ── List ──────────────────────────────────────────────────────────────────

  async list(orgId: string): Promise<string[]> {
    const prefix = `xspace-${orgId.replace(/[^a-zA-Z0-9_-]/g, '-')}-`
    const filter = `name:${prefix}`

    const keys: string[] = []
    const iterable = this.client.listSecretsAsync({
      parent: this.secretParent(),
      filter,
    })

    for await (const secret of iterable) {
      const secretId = secret.name?.split('/').pop() ?? ''
      if (secretId.startsWith(prefix)) {
        keys.push(secretId.slice(prefix.length))
      }
    }

    return keys
  }
}
