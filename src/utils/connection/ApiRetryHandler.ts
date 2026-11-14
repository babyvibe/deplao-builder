import Logger from '../Logger';
import { tr } from '../../shared/i18n';

export interface RetryOptions {
    maxRetries?: number; // Max number of retries (default: 3)
    currentRetry?: number; // Current retry (starts at 0)
    zaloId?: string; // Zalo ID used to get the connection and proxy
    operationName?: string; // Operation name for logs
}

export interface ApiCallResult<T> {
    success: boolean;
    data?: T;
    error?: {
        message: string;
        retryCount?: number;
    };
}

/**
 * Check if error is retryable (502 or TLS connection errors)
 * Check whether the error can be retried (502 or TLS connection errors)
 */
function isRetryableError(error: any): boolean {
    const errorMessage = error?.message || error?.toString() || '';

    // Check for 502 Bad Gateway
    if (errorMessage.includes('Request failed with status code 502') ||
        errorMessage.includes('status code 502')) {
        return true;
    }

    // Check for TLS connection errors
    if (errorMessage.includes('Client network socket disconnected before secure TLS connection was established')) {
        return true;
    }

    // Check for ECONNREFUSED (connection refused)
    return errorMessage.includes('ECONNREFUSED');
}

/**
 * Get user-friendly error message based on error type
 */
function getUserFriendlyErrorMessage(error: any, retryCount: number): string {
    const errorMessage = error?.message || error?.toString() || '';

    if (errorMessage.includes('ECONNREFUSED') && retryCount >= 3) {
        return tr('Kết nối Zalo cá nhân bị gián đoạn [ECONNREFUSED]. Vui lòng thao tác lại!');
    }

    if (errorMessage.includes('Request failed with status code 502') && retryCount >= 3) {
        return tr('Lỗi kết nối proxy [502 Bad Gateway]. Vui lòng thao tác lại!');
    }

    if (errorMessage.includes('Client network socket disconnected') && retryCount >= 3) {
        return tr('Lỗi kết nối TLS. Vui lòng thao tác lại!');
    }

    return errorMessage;
}

/**
 * Execute API call with automatic retry
 * Run the API call with automatic retry
 *
 * @param apiCall Function that performs the API call
 * @param options Retry options
 * @returns ApiCallResult with data or error
 */
export async function executeWithRetry<T>(
    apiCall: () => Promise<T>,
    options: RetryOptions = {}
): Promise<ApiCallResult<T>> {
    const {
        maxRetries = 3,
        currentRetry = 0,
        zaloId,
        operationName = 'API Call'
    } = options;

    try {
        // Execute the API call
        const result = await apiCall();

        // Success - return result
        return {
            success: true,
            data: result
        };

    } catch (error: any) {
        const errorMessage = error?.message || error?.toString() || 'Unknown error';

        Logger.error(`[ApiRetryHandler] ${operationName} failed (attempt ${currentRetry + 1}/${maxRetries + 1}): ${errorMessage}`);

        // Check if error is retryable and we haven't exceeded max retries
        if (isRetryableError(error) && currentRetry < maxRetries) {
            Logger.warn(`[ApiRetryHandler] Retrying ${operationName} (${currentRetry + 1}/${maxRetries})...`);

            // Wait for a while before retrying
            await new Promise(resolve => setTimeout(resolve, 1000 * (currentRetry + 1)));

            // Retry the API call with incremented retry count
            return executeWithRetry(apiCall, {
                ...options,
                currentRetry: currentRetry + 1
            });
        }

        // Max retries reached or non-retryable error
        const friendlyMessage = getUserFriendlyErrorMessage(error, currentRetry);

        return {
            success: false,
            error: {
                message: friendlyMessage,
                retryCount: currentRetry
            }
        };
    }
}
