// =============================================================================
// RBAC — Re-exports
// =============================================================================

export {
  PERMISSION_SCOPES,
  ROLES,
  resolvePermissions,
  roleHasPermission,
  roleHasAllPermissions,
  isRoleAtLeast,
  matchesPermission,
  hasPermission,
  isValidPermission,
  validatePermissions,
  type Permission,
  type BuiltInRole,
  type RoleDefinition,
} from './permissions'
