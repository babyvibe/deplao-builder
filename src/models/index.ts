// Core DB models
export type { Account } from './accounts/account';
export type { Message, MessageDraft } from './chat/message';
export type { Contact, Friend, PageGroupMember, FriendRequest, Link } from './chat/contact';

// CRM
export type {
    CRMNote, CRMCampaign, CRMCampaignContact, CRMSendLog,
    CRMTag, CRMContactTag,
    CRMCampaignStatus, CRMContactStatus, CRMCampaignType,
} from './crm/crm';

// Facebook
export type {
    FBAccountRecord, FBAccountStatus,
    FBThread, FBThreadType, FBThreadParticipant,
    FBMessage, FBMessageType, FBMessageRecord,
    FBAttachment, FBAttachmentUploadResult,
    FBSendOptions, FBSendResult, FBSessionData, FBLoginResult,
    FBAddAccountPayload, FBSendMessagePayload,
    FBCRMContactRecord,
    FBConnectionStatus, FBReactionAction,
    FBE2EEStatus, FBE2EEBridgeConfig, FBE2EESendPayload, FBE2EESendResult, FBE2EEMessageRaw,
    FBJsonRpcRequest, FBJsonRpcResponse, FBJsonRpcEvent,
} from './facebook/facebook';

// AI
export type { AIAssistant, AIAssistantFile, ChatMessage, AIPlatform, AIUsageLog, AIAccountAssistant } from './ai/ai';

// Employee
export type {
    Employee, EmployeePermission, EmployeeWithDetails, EmployeeModule,
    EmployeeGroup, EmployeeSession, EmployeeMessageLog,
} from './employee/employee';
export { ALL_MODULES } from './employee/employee';

// Proxy
export type { ProxyConfig } from './accounts/proxy';

// Workflow
export type { Workflow, WorkflowRunLog } from './workflow/workflow';

// Integration
export type { Integration } from './integrations/integration';

// ERP
export type { ErpDepartment, ErpPosition, ErpEmployeeProfile, ErpAttendance, ErpLeaveRequest } from './erp/Hrm';
export type { ErpProject, CreateProjectInput, UpdateProjectInput } from './erp/Project';
export type {
    ErpTask, ErpTaskDetail, ErpTaskDependency, ErpChecklistItem,
    ErpComment, ErpAttachment, ErpActivityLog, CreateTaskInput, UpdateTaskInput,
} from './erp/Task';
export type { ErpCalendarEvent, ErpEventAttendee, ErpEventReminder, CreateCalendarEventInput } from './erp/CalendarEvent';
export type { ErpNoteFolder, ErpNote, ErpNoteTag, ErpNoteVersion, ErpNoteShare } from './erp/Note';
export type { ErpNotification } from './erp/ErpNotification';
export type { ErpRole, ErpPermissionAction, ErpPermissionOverrideMode, ErpPermissionOverrides } from './erp/Permission';
