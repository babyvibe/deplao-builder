// Re-exported from FacebookTypes.ts - single source of truth for Facebook types
// All FB services import from ./FacebookTypes, centralized consumers import from src/models
export type {
    FBAccountRecord, FBAccountStatus,
    FBThread, FBThreadType, FBThreadParticipant,
    FBSessionData, FBLoginResult,
    FBMessage, FBMessageType, FBMessageRecord,
    FBAttachment, FBAttachmentUploadResult,
    FBSendOptions, FBSendResult,
    FBAddAccountPayload, FBSendMessagePayload,
    FBThreadDataResult, FBMessageRequest,
    FBReactionAction,
    FBMQTTAttachment, FBMQTTMessage,
    FBConnectionStatus,
    FBE2EEStatus, FBE2EEBridgeConfig,
    FBJsonRpcRequest, FBJsonRpcResponse, FBJsonRpcEvent,
    FBE2EESendPayload, FBE2EESendResult, FBE2EEMessageRaw,
    FBCRMContactRecord,
} from '../../services/facebook/FacebookTypes';
