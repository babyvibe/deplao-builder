// Tái xuất từ FacebookTypes.ts - single source of truth cho Facebook types
// Tất cả FB services import từ ./FacebookTypes, centralized consumers import từ src/models
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
