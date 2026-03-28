// =============================================================================
// Managed Hosting — Secrets Manager Interface
// =============================================================================

export interface SecretsManager {
  get(orgId: string, key: string): Promise<string | undefined>
  set(orgId: string, key: string, value: string): Promise<void>
  delete(orgId: string, key: string): Promise<void>
  list(orgId: string): Promise<string[]>
}
