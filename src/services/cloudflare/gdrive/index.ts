/**
 * Google Drive làm kho lưu (thay R2): đăng nhập OAuth (googleOAuth), lớp HTTP (DriveApi), client kiểu R2Client cho
 * từng "bucket" = thư mục Deplao/<bucket> (DriveStore), dịch vụ gom (GoogleDriveService).
 *
 * CloudflareService gọi createGoogleDrive() trong constructor — hàm này không chạm Electron / mạng / đĩa. Không import
 * CloudflareService ở đây (vòng import): mọi thứ cần dùng đi qua deps.
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
