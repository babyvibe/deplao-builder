/**
 * Index of the v1 routes. To add a new group: create a file in routes/, then declare it here.
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
import { mediaRoutes } from './media';
import { employeeRoutes } from './employees';

export interface RouteDeps {
    uploads: UploadStore;
    /** Extra routes (events, webhooks, plugins) provided by ApiPlatform. */
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
        mediaRoutes({ uploads: deps.uploads }),
        employeeRoutes(),
    ];
    for (const extra of deps.extra || []) groups.push(extra());
    return groups.flat();
}
