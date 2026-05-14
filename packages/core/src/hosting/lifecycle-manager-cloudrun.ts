// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§94]

// =============================================================================
// Cloud Run Lifecycle Manager
// Implements the LifecycleManager interface using Google Cloud Run v2.
// Each tenant deployment maps to a Cloud Run service named xspace-agent-<deploymentId>.
// =============================================================================

import { ServicesClient } from '@google-cloud/run'
import { getAppLogger } from '../observability/logger'
import type { LifecycleManager, LifecycleStartInput, SleepInput, WakeInput } from './lifecycle-manager'
import type { ResourceUsage } from './types'

const log = getAppLogger('lifecycle-cloudrun')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CloudRunLifecycleConfig {
  projectId: string
  region: string
  /** Docker image to run for agent deployments. */
  agentImage: string
  /** VPC connector resource name for private Cloud SQL/Redis access. */
  vpcConnector?: string
  /** Cloud Run service account email for agent services. */
  serviceAccountEmail?: string
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class CloudRunLifecycleManager implements LifecycleManager {
  private client: ServicesClient
  private config: CloudRunLifecycleConfig

  constructor(config: CloudRunLifecycleConfig) {
    this.client = new ServicesClient()
    this.config = config
  }

  private serviceName(deploymentId: string): string {
    // Cloud Run service names must be lowercase alphanumeric + hyphens, max 49 chars
    const safe = deploymentId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)
    return `xspace-agent-${safe}`
  }

  private serviceParent(): string {
    return `projects/${this.config.projectId}/locations/${this.config.region}`
  }

  private serviceFullName(deploymentId: string): string {
    return `${this.serviceParent()}/services/${this.serviceName(deploymentId)}`
  }

  // ── Start ────────────────────────────────────────────────────────────────

  async start(input: LifecycleStartInput): Promise<string> {
    const { deploymentId, imageTag, config, secrets, domain } = input
    const name = this.serviceName(deploymentId)

    const envVars = Object.entries(config)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => ({ name: k, value: String(v) }))

    const secretEnvVars = Object.entries(secrets).map(([k, secretName]) => ({
      name: k,
      valueSource: {
        secretKeyRef: {
          secret: secretName,
          version: 'latest',
        },
      },
    }))

    const serviceBody = {
      name: `${this.serviceParent()}/services/${name}`,
      template: {
        serviceAccount: this.config.serviceAccountEmail,
        scaling: {
          minInstanceCount: 0,
          maxInstanceCount: 1,
        },
        ...(this.config.vpcConnector && {
          vpcAccess: {
            connector: this.config.vpcConnector,
            egress: 'PRIVATE_RANGES_ONLY' as const,
          },
        }),
        containers: [
          {
            image: imageTag || this.config.agentImage,
            env: [
              ...envVars,
              ...secretEnvVars,
              { name: 'DEPLOYMENT_ID', value: deploymentId },
            ],
            resources: {
              limits: { cpu: '1', memory: '1Gi' },
              cpuIdle: true,
              startupCpuBoost: true,
            },
            ports: [{ name: 'http1', containerPort: 3000 }],
            startupProbe: {
              httpGet: { path: '/health', port: 3000 },
              initialDelaySeconds: 10,
              periodSeconds: 10,
              failureThreshold: 5,
              timeoutSeconds: 3,
            },
          },
        ],
      },
      labels: {
        'xspace-deployment-id': deploymentId,
        'managed-by': 'xspace-platform',
      },
    }

    try {
      // Check if service already exists
      const exists = await this.client.getService({ name: this.serviceFullName(deploymentId) })
        .then(() => true)
        .catch(() => false)

      let operation
      if (exists) {
        ;[operation] = await this.client.updateService({ service: serviceBody as any })
      } else {
        ;[operation] = await this.client.createService({
          parent: this.serviceParent(),
          service: serviceBody as any,
          serviceId: name,
        })
      }

      const [response] = await operation.promise()
      const url = (response as any).uri as string

      log.info({ deploymentId, name, url }, 'cloud run service deployed')
      return url
    } catch (err: any) {
      log.error({ err: err.message, deploymentId }, 'cloud run service creation failed')
      throw err
    }
  }

  // ── Stop (delete the Cloud Run service) ─────────────────────────────────

  async stop(deploymentId: string): Promise<void> {
    try {
      const [operation] = await this.client.deleteService({
        name: this.serviceFullName(deploymentId),
      })
      await operation.promise()
      log.info({ deploymentId }, 'cloud run service deleted')
    } catch (err: any) {
      if (err.code === 5) {
        log.warn({ deploymentId }, 'cloud run service not found — already stopped')
        return
      }
      throw err
    }
  }

  // ── Restart (update with same image to force new instance) ───────────────

  async restart(deploymentId: string): Promise<void> {
    const [service] = await this.client.getService({ name: this.serviceFullName(deploymentId) })
    const [operation] = await this.client.updateService({ service: service as any })
    await operation.promise()
    log.info({ deploymentId }, 'cloud run service restarted')
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async getStatus(deploymentId: string): Promise<string> {
    try {
      const [service] = await this.client.getService({ name: this.serviceFullName(deploymentId) })
      const conditions: any[] = (service as any).conditions ?? []
      const ready = conditions.find((c: any) => c.type === 'Ready')
      if (!ready) return 'deploying'
      if (ready.state === 'CONDITION_SUCCEEDED') return 'running'
      if (ready.state === 'CONDITION_FAILED') return 'failed'
      return 'deploying'
    } catch (err: any) {
      if (err.code === 5) return 'stopped'
      throw err
    }
  }

  // ── Sleep (scale to 0) ────────────────────────────────────────────────────

  async sleep(input: SleepInput): Promise<void> {
    const [service] = await this.client.getService({ name: this.serviceFullName(input.deploymentId) })
    const s = service as any
    if (!s.template) s.template = {}
    if (!s.template.scaling) s.template.scaling = {}
    s.template.scaling.maxInstanceCount = 0

    const [operation] = await this.client.updateService({ service: s })
    await operation.promise()
    log.info({ deploymentId: input.deploymentId, reason: input.reason }, 'cloud run service sleeping')
  }

  // ── Wake (scale back up) ─────────────────────────────────────────────────

  async wake(input: WakeInput): Promise<void> {
    const [service] = await this.client.getService({ name: this.serviceFullName(input.deploymentId) })
    const s = service as any
    if (!s.template) s.template = {}
    if (!s.template.scaling) s.template.scaling = {}
    s.template.scaling.maxInstanceCount = 1

    const [operation] = await this.client.updateService({ service: s })
    await operation.promise()
    log.info({ deploymentId: input.deploymentId, reason: input.reason }, 'cloud run service waking')
  }

  // ── Logs (via Cloud Logging API) ─────────────────────────────────────────

  async getLogs(deploymentId: string, tail: number = 100): Promise<string[]> {
    // Pull structured logs from Cloud Logging via gcloud CLI (avoids extra SDK dep)
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const exec = promisify(execFile)

    const serviceName = this.serviceName(deploymentId)
    const filter = [
      `resource.type="cloud_run_revision"`,
      `resource.labels.service_name="${serviceName}"`,
    ].join('\n')

    try {
      const { stdout } = await exec('gcloud', [
        'logging', 'read', filter,
        `--project=${this.config.projectId}`,
        `--limit=${tail}`,
        '--format=value(textPayload)',
        '--order=desc',
      ])
      return stdout.trim().split('\n').reverse().filter(Boolean)
    } catch {
      return [`[logs unavailable — ensure gcloud CLI is authenticated]`]
    }
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  async getMetrics(deploymentId: string): Promise<ResourceUsage> {
    // Basic status check — Cloud Monitoring metrics require a separate client
    const status = await this.getStatus(deploymentId)
    return {
      activeSessions: status === 'running' ? 1 : 0,
    }
  }
}
