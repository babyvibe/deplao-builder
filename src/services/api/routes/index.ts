/**
 * Danh mục route v1. Thêm nhóm mới: tạo file trong routes/ rồi khai báo ở đây.
 */
import type { RouteDef } from '../types';
import type { UploadStore } from '../UploadStore';
import { systemRoutes } from './system';
import { accountRoutes } from './accounts';
import { chatRoutes } from './chat';
import { chatExtraRoutes } from './chatExtra';
import { labelRoutes } from './labels';
import { labelExtraRoutes } from './labelsExtra';
import { groupRoutes } from './groups';
import { groupExtraRoutes } from './groupsExtra';
import { zaloFeatureRoutes } from './zaloFeatures';
import { crmRoutes } from './crm';
import { workflowRoutes } from './workflows';
import { integrationRoutes } from './integrations';
import { erpRoutes } from './erp';
import { aiRoutes } from './ai';
import { mediaRoutes } from './media';
import { employeeRoutes } from './employees';

export interface RouteDeps {
    uploads: UploadStore;
    /** Route bổ sung (events, webhooks, plugins) do ApiPlatform cung cấp. */
    extra?: Array<() => RouteDef[]>;
}

export function buildRoutes(deps: RouteDeps): RouteDef[] {
    const groups: RouteDef[][] = [
        systemRoutes(),
        accountRoutes(),
        chatRoutes({ uploads: deps.uploads }),
        chatExtraRoutes({ uploads: deps.uploads }),
        labelRoutes(),
        labelExtraRoutes(),
        groupRoutes(),
        groupExtraRoutes({ uploads: deps.uploads }),
        zaloFeatureRoutes({ uploads: deps.uploads }),
        crmRoutes(),
        workflowRoutes(),
        integrationRoutes(),
        erpRoutes(),
        aiRoutes(),
        mediaRoutes({ uploads: deps.uploads }),
        employeeRoutes(),
    ];
    for (const extra of deps.extra || []) groups.push(extra());
    return groups.flat();
}
