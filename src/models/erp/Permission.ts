/**
 * Re-export of the canonical ERP permission matrix from
 * `src/services/erp/permissions.ts` — kept here for backwards-compatible
 * UI imports via `@/models/erp`.
 */
export {
  ERP_PERMISSIONS,
  ERP_PERMISSION_GROUPS,
  ERP_PERMISSION_META,
  erpCan,
  erpCanWithOverrides,
  isErpPermissionAction,
  parseErpPermissionOverridesFromExtraJson,
  sanitizeErpPermissionOverrides,
  stringifyErpPermissionOverridesToExtraJson,
} from '../../services/erp/permissions';
export type {
  ErpRole,
  ErpPermissionAction,
  ErpPermissionOverrideMode,
  ErpPermissionOverrides,
} from '../../services/erp/permissions';

