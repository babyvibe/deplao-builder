/**
 * Google Drive as the storage (instead of R2): OAuth sign-in (googleOAuth), the HTTP layer (DriveApi), an R2Client-style client for
 * each "bucket" = folder Deplao/<bucket> (DriveStore), and the aggregating service (GoogleDriveService).
 *
 * CloudflareService calls createGoogleDrive() in its constructor; this function does not touch Electron / network / disk. Do not import
 * CloudflareService here (import cycle): everything needed comes in through deps.
 */
import type { GoogleDriveCore } from '../contracts';
import { GoogleDriveService } from './GoogleDriveService';
import type { GoogleDriveDeps } from './GoogleDriveService';

export function createGoogleDrive(deps: GoogleDriveDeps): GoogleDriveCore {
    return new GoogleDriveService(deps);
}

export { GoogleDriveService, ROOT_FOLDER_NAME, parseQuota } from './GoogleDriveService';
export type { GoogleDriveDeps } from './GoogleDriveService';
export { DriveStore, toAppProperties, DRIVE_SIMPLE_UPLOAD_MAX, DRIVE_CHUNK_SIZE } from './DriveStore';
export type { DriveStoreOptions } from './DriveStore';
export {
    DriveApi, mapDriveError, escapeQueryValue, isDriveRetryable, FOLDER_MIME, DRIVE_API, DRIVE_UPLOAD_API,
} from './DriveApi';
export type { DriveFetch, DriveFetchResponse, DriveFileMeta, DriveApiOptions } from './DriveApi';
export { BUILTIN_GOOGLE_CLIENT } from './googleOAuthClient';
export {
    DRIVE_FILE_SCOPE, buildAuthorizeUrl, createPkcePair, createOAuthState, exchangeAuthCode, refreshAccessToken, revokeToken,
    startLoopbackLogin,
} from './googleOAuth';
