"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stringifyErpPermissionOverridesToExtraJson = exports.sanitizeErpPermissionOverrides = exports.parseErpPermissionOverridesFromExtraJson = exports.isErpPermissionAction = exports.erpCanWithOverrides = exports.erpCan = exports.ERP_PERMISSION_META = exports.ERP_PERMISSION_GROUPS = exports.ERP_PERMISSIONS = void 0;
/**
 * Re-export of the canonical ERP permission matrix from
 * `src/services/erp/permissions.ts` — kept here for backwards-compatible
 * UI imports via `@/models/erp`.
 */
var permissions_1 = require("../../services/erp/permissions");
Object.defineProperty(exports, "ERP_PERMISSIONS", { enumerable: true, get: function () { return permissions_1.ERP_PERMISSIONS; } });
Object.defineProperty(exports, "ERP_PERMISSION_GROUPS", { enumerable: true, get: function () { return permissions_1.ERP_PERMISSION_GROUPS; } });
Object.defineProperty(exports, "ERP_PERMISSION_META", { enumerable: true, get: function () { return permissions_1.ERP_PERMISSION_META; } });
Object.defineProperty(exports, "erpCan", { enumerable: true, get: function () { return permissions_1.erpCan; } });
Object.defineProperty(exports, "erpCanWithOverrides", { enumerable: true, get: function () { return permissions_1.erpCanWithOverrides; } });
Object.defineProperty(exports, "isErpPermissionAction", { enumerable: true, get: function () { return permissions_1.isErpPermissionAction; } });
Object.defineProperty(exports, "parseErpPermissionOverridesFromExtraJson", { enumerable: true, get: function () { return permissions_1.parseErpPermissionOverridesFromExtraJson; } });
Object.defineProperty(exports, "sanitizeErpPermissionOverrides", { enumerable: true, get: function () { return permissions_1.sanitizeErpPermissionOverrides; } });
Object.defineProperty(exports, "stringifyErpPermissionOverridesToExtraJson", { enumerable: true, get: function () { return permissions_1.stringifyErpPermissionOverridesToExtraJson; } });
//# sourceMappingURL=Permission.js.map