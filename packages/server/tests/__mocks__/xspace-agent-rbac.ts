// Stub mock for xspace-agent/rbac/permissions sub-path
import { vi } from 'vitest'

export const hasPermission = vi.fn(() => true)
export type Permission = string
export type BuiltInRole = string
