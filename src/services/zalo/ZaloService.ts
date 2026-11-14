import {
    MuteAction,
    MuteDuration,
    AcceptFriendRequestResponse,
    AddReactionResponse,
    AddUnreadMarkResponse,
    AddUserToGroupResponse,
    API,
    BlockUserResponse,
    ChangeGroupAvatarResponse,
    ChangeGroupNameResponse,
    CreateGroupResponse,
    CreateReminderOptions,
    CreateReminderResponse,
    DeleteChatLastMessage,
    DeleteChatResponse,
    DeleteMessageDestination,
    DeleteMessageResponse,
    DisableGroupLinkResponse,
    DisperseGroupResponse,
    EditReminderOptions,
    EditReminderResponse,
    EnableGroupLinkResponse,
    FindUserResponse,
    ForwardMessagePayload,
    ForwardMessageResponse,
    GetAliasListResponse,
    GetAllFriendsResponse,
    GetAllGroupsResponse,
    GetArchivedChatListResponse,
    GetFriendRequestStatusResponse,
    GetGroupChatHistoryResponse,
    GetListReminderResponse,
    GetPendingGroupMembersResponse,
    GetPinConversationsResponse,
    GetReminderResponse,
    GetReminderResponsesResponse,
    GetSentFriendRequestResponse,
    GroupInfoResponse,
    KeepAliveResponse,
    LeaveGroupResponse,
    ListReminderOptions,
    MessageContent,
    Reactions,
    RejectFriendRequestResponse,
    RemoveFriendAliasResponse,
    RemoveReminderResponse,
    RemoveUserFromGroupResponse, SendBankCardPayload,
    SendBankCardResponse,
    SendCardResponse,
    SendSeenEventResponse,
    SendFriendRequestResponse,
    SendVideoOptions,
    SendVideoResponse,
    SendVoiceOptions,
    SendVoiceResponse,
    SetHiddenConversationsResponse,
    SetPinnedConversationsResponse,
    StickerDetailResponse,
    ThreadType,
    UnBlockUserResponse,
    UndoPayload,
    UndoResponse,
    UpdateArchivedChatListResponse,
    UpdateArchivedChatListTarget,
    UpdateGroupSettingsOptions,
    UpdateGroupSettingsResponse,
    UserInfoResponse,
    UserMessage
} from "zca-js";
import axios from "axios";
import path from "path";
import * as fs from "node:fs";
import {SendMessageResult} from "zca-js/dist/apis/sendMessage";
import {SendCardOptions} from "zca-js/dist/apis/sendCard";
import ConnectionManager from "../../utils/connection/ConnectionManager";
import {SendLinkOptions, SendLinkResponse} from "zca-js/dist/apis/sendLink";
import {GetGroupLinkDetailResponse} from "zca-js/dist/apis/getGroupLinkDetail";
import {imageSize} from "image-size";
import {convertThreadType, isImageFile} from "../../utils/zalo/Utils";
import Logger from "../../utils/Logger";
import { getZaloFriendOnlines, getZaloPresence } from "./zaloPresenceCache";
import { applyZaloAutoDeleteList, applyZaloAutoDeleteOne } from "./zaloAutoDeleteSync";
import type { ZaloPresence } from "../../shared/zalo/zaloPresence";
import { isZaloAutoDeleteTtl } from "../../shared/zalo/zaloAutoDelete";
import { isValidZaloSettingValue } from "../../shared/zalo/zaloPrivacySettings";
import {
    ZALO_PRODUCT_MAX_PHOTOS, mapZaloCatalog, mapZaloProduct, normalizeProductPrice, validateZaloProduct,
    type ZaloCatalog, type ZaloProduct,
} from "../../shared/zalo/zaloCatalog";
import {
    hiddenStatus, resetZaloHiddenPin, setZaloConversationHidden, setZaloHiddenPin, syncZaloHidden, unlockZaloHidden, zaloHiddenApiOf,
    type HiddenStatus, type UnlockResult,
} from "./zaloHiddenConversations";
import { tr } from '../../shared/i18n';


interface Auth {
    cookies: string;
    imei: string;
    userAgent: string;
    accountId?: string;
    zalo_id?: string;
    zaloId?: string;
}
export default class ZaloService {
    private static instances: Map<string, ZaloService> = new Map();
    private api: API | undefined;
    private auth: Auth;
    private zaloId: string | null = null;

    /**
     * Initialize a new ZaloService object
     * @param auth Zalo ID of the user
     */
    constructor(auth: Auth) {
        this.auth = auth;
    }
    
    /**
     * Get or create an instance of ZaloService
     * @returns Promise<ZaloService> Instance of ZaloService
     * @param auth
     * @param isReconnection Whether this is a reconnection (force delete old connection and create new)
     */
    public static async getInstance(auth: any, isReconnection: boolean = false): Promise<ZaloService> {
        const parsedAuth = typeof auth === 'string' ? JSON.parse(auth) : auth;
        const key = Buffer.from(parsedAuth.cookies).toString('base64');

        // If reconnection, remove existing instance to force recreation
        // If reconnection, delete the existing instance to force a new one
        if (isReconnection && this.instances.has(key)) {
            Logger.log(`[${new Date().toISOString()}] [ZaloService] 🔄 Reconnection: Removing existing ZaloService instance`);
            this.instances.delete(key);
        }

        if (!this.instances.has(key)) {
            const instance = new ZaloService(parsedAuth);
            await instance.initialize(isReconnection);
            this.instances.set(key, instance);
        }
        return this.instances.get(key)!;
    }

    /**
     * Remove a ZaloService instance by zaloId (called when account is disconnected/removed).
     * Prevents stale API instances from accumulating in memory.
     */
    public static removeInstanceByZaloId(zaloId: string): void {
        for (const [key, instance] of this.instances) {
            if (instance.zaloId === zaloId) {
                this.instances.delete(key);
                Logger.log(`[ZaloService] 🗑️ Removed instance for zaloId=${zaloId}`);
                return;
            }
        }
    }

    /**
     * Initialize the Zalo API for the current instance
     * USES ConnectionManager as the single source of truth
     * API-only mode: does not start the listener (only for API calls)
     * @param isReconnection Whether this is a reconnection (force delete old connection and create new)
     */
    private async initialize(isReconnection: boolean = false): Promise<void> {
        Logger.log(`[${new Date().toISOString()}] [ZaloService] Initializing${isReconnection ? ' (reconnection mode)' : ''}...`);

        // First try: reuse existing connection by zaloId (avoids authKey mismatch
        // when DB stores encrypted cookies but QR login stored plain cookies).
        const existingZaloId = this.auth.accountId || this.auth.zalo_id || this.auth.zaloId || '';
        if (existingZaloId && !isReconnection) {
            const existing = ConnectionManager.getConnection(existingZaloId);
            if (existing?.api) {
                this.api = existing.api;
                this.zaloId = this.api.getOwnId();
                Logger.log(`[${new Date().toISOString()}] [ZaloService] ✅ Initialized for ${this.zaloId} - Reused existing connection (API-only mode)`);
                return;
            }
        }

        // Fallback: get or create connection via auth cookies
        const connection = await ConnectionManager.getOrCreateConnection(this.auth, false, undefined, isReconnection);

        this.api = connection.api;
        this.zaloId = this.api.getOwnId();

        Logger.log(`[${new Date().toISOString()}] [ZaloService] ✅ Initialized for ${this.zaloId} - Using shared API instance from ConnectionManager (API-only mode, no listener)`);
    }

    /**
     * Get the Zalo ID of the current user
     */
    public getZaloId(): string | null {
        return this.zaloId;
    }

    /**
     * Send the "đang gõ" (typing) status. Same as the zalo.sendTyping workflow node:
     * threadType 0 = DM (destType = 3), 1 = group (no destType needed).
     */
    public async sendTypingEvent(threadId: string, type?: ThreadType | number): Promise<any> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        const threadType = Number(type) === 1 ? 1 : 0;
        const destType = threadType === 0 ? 3 : undefined;
        return (this.api as any).sendTypingEvent(threadId, threadType, destType);
    }


    /**
     * Send a message
     * @param message Message content (a string or a MessageContent object)
     * @param threadId ID of the conversation
     * @param type Message type (optional)
     * @param typeMessage Special message type (optional, e.g. 'file',...)
     * @param quote Quoted message (optional)
     * @param mentions Tag all or tag members in 1 group
     * @param styles Text formatting
     * @returns Promise with the result of sending the message and the attachments
     */
    public async sendMessage(
        message: string | { msg: string, attachments?: any[], quote?: any, mentions?: any },
        threadId: string,
        type?: ThreadType | number,
        typeMessage = null,
        quote: any = null,
        mentions: any = null,
        styles: any = null
    ): Promise<{ message: SendMessageResult | null; attachment: SendMessageResult[] }> {
        let filesPath: string[] = [];
        try {
            if (!this.api) {
                throw new Error("API not initialized. Please ensure you've called initialize() first.");
            }

            let messageContent: MessageContent;

            // ALWAYS use API from ConnectionManager for consistency
            // ALWAYS use the API from ConnectionManager to keep things consistent
            const zaloId = this.api.getOwnId();
            const connection = ConnectionManager.getConnection(zaloId);
            const apiSending = connection?.api || this.api;

            Logger.log(`[${new Date().toISOString()}] [ZaloService] 📤 Sending message using ${connection ? 'ConnectionManager API' : 'local API'}`);

            if (typeof message === 'string') {
                messageContent = {msg: message};
            } else {
                if (typeMessage == 'file') {
                    if (!message?.attachments || message?.attachments.length === 0) {
                        throw new Error("No attachments provided for file type message");
                    }


                    filesPath = await this.handleDownloadAttachments(message.attachments);

                    // Read the metadata if it is an image
                    // if not an image, send the file URL directly
                    message.attachments = filesPath.map(filePath => {
                        let attachment: any;

                        if (isImageFile(filePath)) {
                            const buffer = fs.readFileSync(filePath);
                            const baseName = path.basename(filePath);
                            const metadata: any = {totalSize: buffer.length};
                            try {
                                const {width, height} = imageSize(buffer);
                                metadata.width = width ?? 0;
                                metadata.height = height ?? 0;

                                attachment = {
                                    data: buffer,
                                    filename: baseName,
                                    metadata: metadata,
                                }
                            } catch (err) {
                                console.warn(`⚠️ Không đọc được kích thước ảnh: ${filePath}`, err);
                            }
                        } else {
                            attachment = filePath
                        }

                        return attachment;
                    });
                    messageContent = message;
                } else {
                    messageContent = message;
                }
            }

            if (mentions) {
                messageContent.mentions = typeof mentions === 'string' ? JSON.parse(mentions) : mentions;
            }

            if (quote) {
                const quoteParsed = typeof quote === 'string' ? JSON.parse(quote) : quote;
                // Support both old format (with data wrapper) and new format (top level per SendMessageQuote type)
                const quoteData = quoteParsed.data || quoteParsed;

                // ThreadType.Group = 1, ThreadType.User = 0
                const isGroupThread = (type === ThreadType.Group || type === 1);

                let quoteContent = quoteData.content;
                let quoteMsgType: string = quoteData.msgType || 'webchat';

                // ── Normalize msgType for each type ────────────────────────────────
                // chat.recommended / chat.link = shared link (Facebook, web, ...)
                // Real Zalo uses cliMsgType=1 (webchat) + qmsg=JSON string content
                // If 'chat.recommended' is left as is → getClientMessageType() = 38
                // → Zalo shows "[danh thiếp] undefined" (a broken contact card) because 38 = card type
                if (quoteMsgType === 'chat.recommended' || quoteMsgType === 'chat.link') {
                    quoteMsgType = 'webchat';
                }

                // ── Stringify content cho individual chat ───────────────────────────
                // zca-js:  qmsg = typeof content == "string" ? content : prepareQMSG(content)
                // prepareQMSG() returns "" for every type except chat.todo
                // → if content is an object, qmsg="" → Zalo cannot show the quote
                //
                // Real Zalo (evidence from the webhook log):
                //   text  : cliMsgType=1,  qmsg="the text"
                //   link  : cliMsgType=1,  qmsg=JSON string of TAttachmentContent
                //   file  : cliMsgType=46, qmsg=JSON string of TAttachmentContent
                //
                // → Individual: stringify so qmsg receives a JSON string ✓
                // → Group: keep the object so prepareQMSGAttach() builds qmsgAttach correctly ✓
                if (!isGroupThread && typeof quoteContent === 'object' && quoteContent !== null) {
                    quoteContent = JSON.stringify(quoteContent);
                }

                messageContent.quote = {
                    content: quoteContent,
                    msgType: quoteMsgType,
                    propertyExt: quoteData.propertyExt ?? undefined,
                    uidFrom: quoteData.uidFrom,
                    msgId: String(quoteData.msgId),
                    cliMsgId: String(quoteData.cliMsgId),
                    ts: String(quoteData.ts),
                    ttl: quoteData.ttl ?? 0,
                };
            }

            if (styles) {
                messageContent.styles = typeof styles === 'string' ? JSON.parse(styles) : styles;
            }

            return await apiSending.sendMessage(messageContent, threadId, type);
        } catch (error: any) {
            throw new Error("Error sending message: " + error.message || error);
        } finally {
            // Delete the temporary files after sending
            if (filesPath.length > 0) {
                await this.deleteTemporaryFiles(filesPath);
            }
        }
    }

    /**
     * Send a sticker
     * @param stickerId ID of the sticker to send
     * @param threadId ID of the user/group to send to
     * @param type Thread type: user/group (default is user)
     * @returns Promise with the result of sending the sticker
     */
    public async sendSticker(stickerId: number, threadId: string, type: ThreadType = ThreadType.User): Promise<SendMessageResult> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            // Get the sticker details
            const stickersDetail = await this.api.getStickersDetail(stickerId);
            if (stickersDetail.length === 0) {
                throw new Error("Sticker not found");
            }

            // Send the sticker
            return await this.api.sendSticker(stickersDetail[0], threadId, type);
        } catch (error: any) {
            throw new Error("Error sending sticker: " + error.message || error);
        }
    }

    /**
     * Add a reaction (emoji) to a message
     * @param reaction Reaction to add (from the Reactions enum)
     * @param message Message object to add the reaction to
     * @returns Promise<AddReactionResponse>
     */
    public async addReaction(reaction: keyof typeof Reactions, message: string): Promise<AddReactionResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            const parsedMessage = JSON.parse(message);
            const msgId = String(parsedMessage.data?.msgId || parsedMessage.msgId || '0');
            // cliMsgId MUST be a parseable integer - fallback to msgId if missing/empty
            const rawCliMsgId = parsedMessage.data?.cliMsgId || parsedMessage.cliMsgId;
            const cliMsgId = (rawCliMsgId && String(rawCliMsgId) !== '' && String(rawCliMsgId) !== 'undefined')
                ? String(rawCliMsgId)
                : msgId;

            const dest = {
                data: { msgId, cliMsgId },
                threadId: String(parsedMessage.threadId || ''),
                type: parsedMessage.type ?? 0,
            };
            return await this.api.addReaction(Reactions[reaction], dest as any);
        } catch (error: any) {
            throw new Error("Error sending reaction: " + (error.message || error));
        }
    }

    /**
     * Download the attachments
     * @param attachments Array of attachment URLs
     * @returns Promise<string[]> Array of paths of the downloaded files
     */
    private async handleDownloadAttachments(attachments: string[]): Promise<string[]> {
        const downloadedFiles: string[] = [];
        const imageDir = path.join(__dirname, '..', '..', 'data', 'image_message');

        // Make sure the folder exists
        if (!fs.existsSync(imageDir)) {
            fs.mkdirSync(imageDir, {recursive: true});
        }

        for (const fileUrl of attachments) {
            try {
                let filePath = '';
                const u = new URL(fileUrl);
                const timestamp = Date.now();
                const randomString = this.generateRandomString(5);
                const fileName = this.getFileNameFromUrl(fileUrl);

                //  For file sends, create a temporary folder to keep the original file name
                if (u.searchParams.get("name")) {
                    // Create a temporary folder
                    const folderPathCreated = path.join(imageDir, `${timestamp}_${randomString}`);
                    fs.mkdirSync(folderPathCreated, {recursive: true});
                    filePath = path.join(folderPathCreated, `${fileName}`);
                } else {
                    filePath = path.join(imageDir, `${timestamp}_${randomString}_${fileName}`);
                }

                const response = await axios({
                    method: 'GET',
                    url: fileUrl,
                    responseType: 'stream'
                });

                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);

                await new Promise<void>((resolve, reject) => {
                    writer.on('finish', () => resolve());
                    writer.on('error', reject);
                });

                downloadedFiles.push(filePath);
            } catch (error) {
                // console.error(`Error downloading file from ${fileUrl}:`, error);
            }
        }

        return downloadedFiles;
    }

    private getFileNameFromUrl(url: string): string | null {
        const u = new URL(url);
        return u.searchParams.get("name") || path.basename(u.pathname)
    }

    /**
     * Generate a random string
     * @param length Length of the string to generate
     * @returns string Random string
     */
    private generateRandomString(length: number): string {
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        return result;
    }

    /**
     * Delete the temporary files
     * @param filePaths Array of paths of the files to delete
     * also deletes the temporary folder when a file was sent
     */
    private async deleteTemporaryFiles(filePaths: string[]): Promise<void> {
        const baseFolder = path.join(__dirname, "..", "..", "data", "image_message");
        for (const filePath of filePaths) {
            try {
                await fs.promises.unlink(filePath);

                const folderPath = path.dirname(filePath);
                const relative = path.relative(baseFolder, folderPath);

                if (relative === "") {
                    // file sits directly in image_message -> delete only the file
                } else if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
                    // folderPath is a child of baseFolder -> delete the folder too
                    await fs.promises.rmdir(folderPath, {recursive: true});
                }

            } catch (error) {
                // console.error(`Error deleting temporary file ${filePath}:`, error);
            }
        }
    }

    /**
     * Get a list of stickers by keyword
     * @param keyword Keyword to search stickers with
     */
    public async getStickers(keyword: string): Promise<number[]> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getStickers(keyword);
        } catch (error: any) {
            throw new Error("Error getting stickers: " + error.message || error);
        }
    }

    /**
     * Get the details of stickers by ID
     * @param stickerIds ID of a sticker or an array of sticker IDs to get details for
     */
    public async getStickersDetail(stickerIds: number | number[]): Promise<StickerDetailResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getStickersDetail(stickerIds);
        } catch (error: any) {
            throw new Error("Error getting sticker details: " + error.message || error);
        }
    }

    /**
     * Get all stickers in a category/pack
     * @param cateId Sticker category ID
     */
    public async getStickerCategoryDetail(cateId: number): Promise<StickerDetailResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getStickerCategoryDetail(cateId);
        } catch (error: any) {
            throw new Error("Error getting sticker category detail: " + error.message || error);
        }
    }

    /**
     * Unsend a message
     * @param message Message object to unsend
     * @returns Promise<UndoResponse>
     */
    public async undoMessage(message: any): Promise<UndoResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            const parsedMessage = JSON.parse(message);
            const undoOptions: UndoPayload = {
                msgId: parsedMessage.data.msgId,
                cliMsgId: parsedMessage.data.cliMsgId,
            };

            // Use convertThreadType so groups use ThreadType.Group (1) and users use ThreadType.User (0)
            const threadType = convertThreadType(parsedMessage.type);
            const uidFrom: string | undefined = parsedMessage.data?.uidFrom;

            Logger.log(`[ZaloService] undoMessage: msgId=${parsedMessage.data.msgId} threadId=${parsedMessage.threadId} type=${threadType}(raw=${parsedMessage.type})${uidFrom ? ` uidFrom=${uidFrom}` : ''}`);

            // Group owner/deputy unsends a member's message - uidFrom must be sent
            if (uidFrom && threadType === ThreadType.Group) {
                return await this.adminRecallGroupMessage(undoOptions, parsedMessage.threadId, uidFrom);
            }

            return await this.api.undo(undoOptions, parsedMessage.threadId, threadType);
        } catch (error: any) {
            throw new Error("Error undoing message: " + (error.message || error));
        }
    }

    /**
     * Admin (group owner/deputy) unsends another member's message in the group.
     * Uses deleteMessage(onlyMe=false) → deletes it for all members.
     * The /api/group/undomsg endpoint only supports the sender unsending their own message, not an admin unsending someone else's.
     */
    private async adminRecallGroupMessage(
        payload: UndoPayload,
        threadId: string,
        uidFrom: string,
    ): Promise<any> {
        if (!this.api) throw new Error("API not initialized");

        Logger.log(`[ZaloService] adminRecallGroupMessage: msgId=${payload.msgId} threadId=${threadId} uidFrom=${uidFrom}`);

        // deleteMessage with onlyMe=false deletes the message for all group members
        // Condition: isSelf=false (admin != sender) so zca-js does not reject it
        return await this.api.deleteMessage(
            {
                threadId,
                type: ThreadType.Group,
                data: {
                    msgId: String(payload.msgId),
                    cliMsgId: String(payload.cliMsgId),
                    uidFrom: String(uidFrom),
                },
            },
            false, // onlyMe = false → delete for everyone
        );
    }

    /**
     * Remove one or more members from the group
     * @param memberId ID of a member or an array of member IDs to remove from the group
     * @param groupId ID of the group
     */
    public async removeUserFromGroup(memberId: string | string[], groupId: string): Promise<RemoveUserFromGroupResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.removeUserFromGroup(memberId, groupId);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Change the group avatar
     * @param avatarPath Path to the new avatar image file
     * @param groupId ID of the group whose avatar to change
     */
    public async changeGroupAvatar(avatarPath: string, groupId: string): Promise<ChangeGroupAvatarResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.changeGroupAvatar(avatarPath, groupId);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Rename the group
     * @param name New name of the group
     * @param groupId ID of the group to rename
     */
    public async changeGroupName(name: string, groupId: string): Promise<ChangeGroupNameResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.changeGroupName(name, groupId);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Send a friend request to a Zalo user
     * @param msg Message content sent with the friend request
     * @param userId ID of the user you want to send the friend request to
     */
    public async sendFriendRequest(msg: string, userId: string): Promise<SendFriendRequestResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.sendFriendRequest(msg, userId);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Search for a Zalo user by phone number
     * @param phoneNumber Phone number of the user to search for
     */
    public async findUser(phoneNumber: string): Promise<FindUserResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.findUser(phoneNumber);
        } catch (error) {
            throw error;
        }
    }


    /**
     * Get the list of all friends of the current user
     */
    public async getAllFriends(): Promise<GetAllFriendsResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getAllFriends();
        } catch (error) {
            throw error;
        }
    }

    /**
     * Get the list of all groups the current user has joined
     */
    public async getAllGroups(): Promise<GetAllGroupsResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getAllGroups();
        } catch (error) {
            throw error;
        }
    }

    /**
     * Delete a message
     * @param message Message object to delete
     * @param onlyMe Delete the message only for yourself (default is true)
     */
    public async deleteMessage(message: any, onlyMe: boolean = true): Promise<DeleteMessageResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        const parsedMessage = JSON.parse(message);
        let options: DeleteMessageDestination = {
            data: {
                cliMsgId: parsedMessage.data.cliMsgId,
                msgId: parsedMessage.data.msgId,
                uidFrom: parsedMessage.data.uidFrom,
            },
            threadId: parsedMessage.threadId,
            type: parsedMessage.type
        }

        // if (parsedMessage.type === ThreadType.User) {
        //     message = new UserMessage(this.api.getOwnId(), parsedMessage.data);
        // } else if (parsedMessage.type === ThreadType.Group) {
        //     message = new GroupMessage(this.api.getOwnId(), parsedMessage.data);
        // }

        try {
            return await this.api.deleteMessage(options, onlyMe);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Delete the chat (hides the conversation on the server)
     * @param lastMessage Info of the last message in the conversation
     * @param threadId ID of the conversation
     * @param type Conversation type (User/Group)
     */
    public async deleteChat(lastMessage: DeleteChatLastMessage, threadId: string, type: ThreadType = ThreadType.User): Promise<DeleteChatResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.deleteChat(lastMessage, threadId, type);
        } catch (error: any) {
            throw new Error("Error deleting chat: " + (error.message || error));
        }
    }

    /**
     * Create a new group on Zalo
     * @param options Options for creating the group, including info such as the group name, member list, etc.
     */
    public async createGroup(options: any): Promise<CreateGroupResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        let filesPath: string[] = [];
        if (options.members && !Array.isArray(options.members)) {
            options.members = options.members.split(",");
        }

        const avatarUrl = options.avatarSource || '';
        if (avatarUrl) {
            filesPath = await this.handleDownloadAttachments([avatarUrl]);
            if (filesPath.length) {
                options.avatarSource = filesPath[0];
            }
        }

        try {
            return await this.api.createGroup(options);
        } catch (error) {
            throw error;
        } finally {
            // Delete the temporary files after sending
            if (filesPath.length > 0) {
                await this.deleteTemporaryFiles(filesPath);
            }
        }
    }

    public async disperseGroup(groupId: string): Promise<DisperseGroupResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.disperseGroup(groupId);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Block a Zalo user
     * @param userId ID of the user to block
     */
    public async blockUser(userId: string): Promise<BlockUserResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.blockUser(userId);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Get the groups shared with a user
     * @param userId ID of the user to look up shared groups for
     */
    public async getRelatedFriendGroup(userId: string): Promise<any> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await (this.api as any).getRelatedFriendGroup(userId);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Add one or more users to the group
     * @param memberId ID of a member or an array of member IDs to add to the group
     * @param groupId ID of the group
     */
    public async addUserToGroup(memberId: string | string[], groupId: string): Promise<AddUserToGroupResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.addUserToGroup(memberId, groupId);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Accept a friend request from a Zalo user
     * @param userId ID of the user who sent the friend request
     */
    public async acceptFriendRequest(userId: string): Promise<AcceptFriendRequestResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.acceptFriendRequest(userId);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Unblock a Zalo user
     * @param userId ID of the user to unblock
     */
    public async unblockUser(userId: string): Promise<UnBlockUserResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.unblockUser(userId);
        } catch (error) {
            throw error;
        }
    }


    /**
     * Get the context of the current login session (uid, phone, loginInfo, ...)
     */
    public getContext(): any {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        return this.api.getContext();
    }

    /**
     * Get info about a Zalo user
     * @param userId ID of the user to get info for
     */
    public async getUserInfo(userId: string | string[]): Promise<UserInfoResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getUserInfo(userId);
        } catch (error: any) {
            // Keep the Zalo error code (ZaloApiError.code) so the caller can classify session expiry / rate limits.
            const wrapped: any = new Error(error?.message || error);
            if (error?.code !== undefined && error?.code !== null) wrapped.code = error.code;
            throw wrapped;
        }
    }

    public async getAliasList(count: number = 100, page: number = 1): Promise<GetAliasListResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getAliasList(count, page);
        } catch (error: any) {
            throw new Error(error.message || error);
        }
    }

    /**
     * Send multiple contact cards to one or more users or groups
     * @param cardsInfo Array with the info of the contact cards to send
     * @returns Promise<SendCardResponse[]>
     */
    public async sendCard(cardsInfo: Array<{
        options: SendCardOptions,
        threadId: string,
        type?: ThreadType,
        quote?: any
    }>): Promise<SendCardResponse[]> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            const sendPromises = cardsInfo.map(({options, threadId, type = ThreadType.User, quote}) => {
                if (!this.api) {
                    throw new Error("API became undefined during execution.");
                }
                const quoteParsed = quote ? (typeof quote === 'string' ? JSON.parse(quote) : quote) : null;
                const payload = quoteParsed ? { ...(options as any), quote: quoteParsed } : options;
                return (this.api as any).sendCard(payload, threadId, type);
            });

            return await Promise.all(sendPromises);
        } catch (error: any) {
            throw new Error("Error sending multiple cards: " + (error.message || error));
        }
    }

    /**
     * Get the detailed info of one or more groups
     * */
    public async getGroupInfo(groupId: string | string[]): Promise<GroupInfoResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getGroupInfo(groupId);
        } catch (error: any) {
            throw new Error(`Error getting group info: ${error.message || error}`);
        }
    }

    public async sendVideo(videoOptions: SendVideoOptions, threadId: string, type?: ThreadType, quote: any = null): Promise<SendVideoResponse> {
        let filesPath: string[] = [];
        try {
            if (!this.api) {
                throw new Error("API not initialized. Please ensure you've called initialize() first.");
            }

            type = convertThreadType(type);
            const quoteParsed = quote ? (typeof quote === 'string' ? JSON.parse(quote) : quote) : null;
            const payload = quoteParsed ? { ...(videoOptions as any), quote: quoteParsed } : videoOptions;
            return await (this.api as any).sendVideo(payload, threadId, type);
        } catch (error: any) {
            throw new Error("Error sending video: " + error.message || error);
        } finally {
            // Delete the temporary files after sending
            if (filesPath.length > 0) {
                await this.deleteTemporaryFiles(filesPath);
            }
        }
    }

    public async keepAlive(): Promise<KeepAliveResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.keepAlive();
        } catch (error: any) {
            throw new Error("Error keeping alive: " + error.message || error);
        }
    }

    public async leaveGroup(groupId: string, silent: boolean = false): Promise<LeaveGroupResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.leaveGroup(groupId, silent);
        } catch (error) {
            throw error;
        }
    }

    public async forwardMessage(payload: ForwardMessagePayload, threadIds: string[], type?: ThreadType): Promise<ForwardMessageResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        type = convertThreadType(type);
        try {
            return await this.api.forwardMessage(payload, threadIds, type);
        } catch (error) {
            throw error;
        }
    }

    public async sendLink(link: string, threadId: string, type?: ThreadType, quote: any = null, message?: string): Promise<SendLinkResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        const quoteParsed = quote ? (typeof quote === 'string' ? JSON.parse(quote) : quote) : null;
        let payload: SendLinkOptions & { quote?: any } = {
            link
        };
        if (message && message.trim()) payload.msg = message.trim();
        if (quoteParsed) payload.quote = quoteParsed;

        type = convertThreadType(type);
        try {
            return await this.api.sendLink(payload, threadId, type);
        } catch (error) {
            throw error;
        }
    }

    public async pinConversation(pinned: boolean, threadId: string, type?: ThreadType): Promise<SetPinnedConversationsResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.setPinnedConversations(pinned, threadId, type);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Mute / unmute a conversation through the Zalo API
     * @param threadId Conversation ID
     * @param threadType 0=User (default), 1=Group
     * @param duration MuteDuration or seconds; undefined = unmute
     * @param action MuteAction.MUTE (1) or MuteAction.UNMUTE (3)
     */
    public async setMute(
        threadId: string,
        threadType: number,
        duration?: MuteDuration | number,
        action: MuteAction = MuteAction.MUTE,
    ): Promise<any> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        const type = threadType === 1 ? ThreadType.Group : ThreadType.User;
        try {
            return await (this.api as any).setMute(
                { duration, action },
                threadId,
                type,
            );
        } catch (error) {
            throw error;
        }
    }

    public async getGroupLinkDetail(groupId: string): Promise<GetGroupLinkDetailResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getGroupLinkDetail(groupId);
        } catch (error) {
            throw error;
        }
    }

    public async getGroupLinkInfo(link: string, memberPage: number = 1): Promise<any> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await (this.api as any).getGroupLinkInfo({ link, memberPage });
        } catch (error) {
            throw error;
        }
    }

    public async joinGroupLink(link: string): Promise<any> {
        if (!this.api) throw new Error("API not initialized. Please ensure you've called initialize() first.");
        try {
            return await (this.api as any).joinGroupLink(link);
        } catch (error: any) {
            // error code 240 = "Waiting for approve" — join request sent, needs admin approval
            if (error?.code === 240 || error?.message?.includes('Waiting for approve')) {
                return { success: true, pendingApproval: true, errorCode: 240, message: tr('Yêu cầu tham gia đã gửi, chờ admin duyệt') };
            }
            throw error;
        }
    }

    public async enableGroupLink(groupId: string): Promise<EnableGroupLinkResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.enableGroupLink(groupId);
        } catch (error) {
            throw error;
        }
    }

    public async disableGroupLink(groupId: string): Promise<DisableGroupLinkResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.disableGroupLink(groupId);
        } catch (error) {
            throw error;
        }
    }

    public async updateGroupSettings(options: string, groupId: string): Promise<UpdateGroupSettingsResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        const parsedOptions: UpdateGroupSettingsOptions = JSON.parse(options);
        try {
            return await this.api.updateGroupSettings(parsedOptions, groupId);
        } catch (error) {
            throw error;
        }
    }

    public async rejectFriendRequest(friendId: string): Promise<RejectFriendRequestResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.rejectFriendRequest(friendId);
        } catch (error) {
            throw error;
        }
    }

    public async getFriendRecommendations(): Promise<any> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await (this.api as any).getFriendRecommendations();
        } catch (error) {
            throw error;
        }
    }

    public async getArchivedChatList(): Promise<GetArchivedChatListResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getArchivedChatList();
        } catch (error) {
            throw error;
        }
    }

    public async setHiddenConversations(hidden: any, threadId: string | string[], type?: ThreadType): Promise<SetHiddenConversationsResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        type = convertThreadType(type);
        try {
            return await this.api.setHiddenConversations(hidden == 1, threadId, type);
        } catch (error) {
            throw error;
        }
    }

    public async getFriendRequestStatus(friendId: string): Promise<GetFriendRequestStatusResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getFriendRequestStatus(friendId);
        } catch (error) {
            throw error;
        }
    }

    public async getPinConversations(): Promise<GetPinConversationsResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getPinConversations();
        } catch (error) {
            throw error;
        }
    }

    public async getLabels(): Promise<any> {
        if (!this.api) throw new Error("API not initialized.");
        try {
            return await (this.api as any).getLabels();
        } catch (error: any) {
            throw new Error("Error getting labels: " + error.message);
        }
    }

    public async updateLabels(labelData: any[], version: number): Promise<any> {
        if (!this.api) throw new Error("API not initialized.");
        try {
            return await (this.api as any).updateLabels({ labelData, version });
        } catch (error: any) {
            throw new Error("Error updating labels: " + error.message);
        }
    }

    public async changeFriendAlias(alias: string, friendId: string): Promise<any> {
        if (!this.api) throw new Error("API not initialized.");
        try {
            return await (this.api as any).changeFriendAlias(alias, friendId);
        } catch (error: any) {
            throw new Error("Error changing alias: " + error.message);
        }
    }

    public async getReminder(reminderId: string): Promise<GetReminderResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getReminder(reminderId);
        } catch (error) {
            throw error;
        }
    }

    public async sendVoice(voiceOptions: SendVoiceOptions, threadId: string, type?: ThreadType, quote: any = null): Promise<SendVoiceResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        const quoteParsed = quote ? (typeof quote === 'string' ? JSON.parse(quote) : quote) : null;
        type = convertThreadType(type);
        try {
            const payload = quoteParsed ? { ...(voiceOptions as any), quote: quoteParsed } : voiceOptions;
            return await (this.api as any).sendVoice(payload, threadId, type);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Upload an audio file to the Zalo server
     * Returns the fileUrl to use in sendVoice.voiceUrl
     */
    public async uploadVoiceFile(voicePath: string, threadId: string, type?: ThreadType): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try {
            const threadType = convertThreadType(type);
            const result = await this.api.uploadAttachment([voicePath], threadId, threadType);
            const resp = Array.isArray(result) ? result[0] : result;
            Logger.info(`[ZaloService] uploadVoiceFile raw result: ${JSON.stringify(resp)}`);
            return resp;
        } catch (error: any) {
            throw new Error('uploadVoiceFile error: ' + error.message);
        }
    }

    public async createReminder(reminderOptions: CreateReminderOptions, threadId: string, type?: ThreadType): Promise<CreateReminderResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        type = convertThreadType(type);
        try {
            return await this.api.createReminder(reminderOptions, threadId, type);
        }
        catch (error) {
            throw error;
        }
    }

    public async editReminder(reminderOptions: EditReminderOptions, threadId: string, type?: ThreadType): Promise<EditReminderResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        type = convertThreadType(type);
        try {
            return await this.api.editReminder(reminderOptions, threadId, type);
        } catch (error) {
            throw error;
        }
    }

    public async removeReminder(reminderId: string, threadId: string, type?: ThreadType): Promise<RemoveReminderResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        type = convertThreadType(type);
        try {
            return await this.api.removeReminder(reminderId, threadId, type);
        } catch (error) {
            throw error;
        }
    }

    public async getListReminder(options: ListReminderOptions, threadId: string, type?: ThreadType): Promise<GetListReminderResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        type = convertThreadType(type);
        try {
            return await this.api.getListReminder(options, threadId, type);
        } catch (error) {
            throw error;
        }
    }

    public async getReminderResponses(reminderId: string): Promise<GetReminderResponsesResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getReminderResponses(reminderId);
        } catch (error) {
            throw error;
        }
    }

    public async removeFriendAlias(friendId: string): Promise<RemoveFriendAliasResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.removeFriendAlias(friendId);
        } catch (error) {
            throw error;
        }
    }

    public async removeFriend(friendId: string): Promise<{ success: boolean }> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            await this.api.removeFriend(friendId);
            return { success: true };
        } catch (error) {
            throw error;
        }
    }

    public async getPendingGroupMembers(groupId: string): Promise<GetPendingGroupMembersResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getPendingGroupMembers(groupId);
        } catch (error) {
            throw error;
        }
    }

    public async getSentFriendRequest(): Promise<GetSentFriendRequestResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getSentFriendRequest();
        } catch (error) {
            throw error;
        }
    }

    /**
     * Get the proxy URL currently used for the current Zalo connection
     * @returns The proxy URL or null if not assigned
     */
    public getProxyUrl(): string | null {
        return null; // No proxy in desktop mode
    }

    /**
     * Send an image from a local file path
     */
    public async sendImage(filePath: string, threadId: string, type: ThreadType = ThreadType.User, caption?: string, quote: any = null): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try {
            if (!filePath || !fs.existsSync(filePath)) {
                throw new Error(tr('Không tìm thấy tệp ảnh để gửi'));
            }
            const threadType = convertThreadType(type);
            const normalizedThreadId = String(threadId || '');
            if (!normalizedThreadId) throw new Error(tr('Thiếu hội thoại nhận ảnh'));

            const buffer = fs.readFileSync(filePath);
            const baseName = path.basename(filePath);
            const extension = path.extname(baseName).toLowerCase();
            if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extension)) {
                throw new Error(tr('Định dạng {{v1}} không được Zalo gửi dưới dạng ảnh', { v1: extension || tr('không có phần mở rộng') }));
            }

            // zca-js treats GIF separately. Supplying it as an image Buffer
            // makes the upload endpoint receive an invalid image payload.
            if (extension === '.gif') {
                const content: MessageContent = { msg: caption || '', attachments: [filePath] };
                return await this.sendMessage(content as any, normalizedThreadId, threadType, null, quote);
            }

            let width = 0, height = 0;
            try { const dim = imageSize(buffer); width = dim.width ?? 0; height = dim.height ?? 0; } catch {}
            if (!width || !height) {
                throw new Error('Không đọc được kích thước ảnh. Vui lòng dùng JPG, PNG hoặc WebP hợp lệ');
            }
            const attachment: any = {
                data: buffer,
                filename: baseName,
                metadata: { totalSize: buffer.length, width, height },
            };
            const content: MessageContent = { msg: caption || '', attachments: [attachment] };
            return await this.sendMessage(content as any, normalizedThreadId, threadType, null, quote);
        } catch (error: any) {
            throw new Error('sendImage error: ' + error.message);
        }
    }

    /**
     * Upload the video's thumbnail image to the Zalo server
     * Returns the URL to use in sendVideo.thumbnailUrl
     */
    public async uploadVideoThumb(thumbPath: string, threadId: string, type?: ThreadType): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try {
            const threadType = convertThreadType(type);
            const result = await this.api.uploadAttachment([thumbPath], threadId, threadType);
            const resp = Array.isArray(result) ? result[0] : result;
            Logger.info(`[ZaloService] uploadVideoThumb raw result: ${JSON.stringify(resp)}`);
            return resp;
        } catch (error: any) {
            throw new Error('uploadVideoThumb error: ' + error.message);
        }
    }

    /**
     * Upload a video file to the Zalo server
     * Returns the fileUrl to use in sendVideo.videoUrl
     */
    public async uploadVideoFile(videoPath: string, threadId: string, type?: ThreadType): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try {
            const threadType = convertThreadType(type);
            const result = await this.api.uploadAttachment([videoPath], threadId, threadType);
            const resp = Array.isArray(result) ? result[0] : result;
            Logger.info(`[ZaloService] uploadVideoFile raw result: ${JSON.stringify(resp)}`);
            return resp;
        } catch (error: any) {
            throw new Error('uploadVideoFile error: ' + error.message);
        }
    }

    /**
     * Send multiple images in one message (uses the groupLayoutId of zca-js)
     */
    public async sendImages(filePaths: string[], threadId: string, type: ThreadType = ThreadType.User, quote: any = null): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        if (!filePaths.length) return [];
        const threadType = convertThreadType(type);
        const normalizedThreadId = String(threadId || '');
        if (!normalizedThreadId) throw new Error(tr('Thiếu hội thoại nhận ảnh'));
        // If there is only 1 image, use the normal sendImage
        if (filePaths.length === 1) return this.sendImage(filePaths[0], normalizedThreadId, threadType, undefined, quote);
        try {
            // The file-check errors below (raised before upload) are recognized by album forwarding, which then resends
            // each image one by one; if you change the wording, also update FORWARD_ALBUM_PRECHECK_ERROR_RE in src/ui/lib/chat/forward/forwardSend.ts.
            const attachments = filePaths.map(filePath => {
                if (!filePath || !fs.existsSync(filePath)) throw new Error('Không tìm thấy một trong các tệp ảnh để gửi');
                const buffer = fs.readFileSync(filePath);
                const baseName = path.basename(filePath);
                // zca-js requires filename to contain an extension (`${string}.${string}`)
                const ext = path.extname(baseName) || '.jpg';
                const safeFilename = (path.extname(baseName) ? baseName : `${baseName}${ext}`) as `${string}.${string}`;
                if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext.toLowerCase())) {
                    throw new Error(`Tệp ${baseName} không phải ảnh JPG, PNG hoặc WebP hợp lệ`);
                }
                let width = 0, height = 0;
                try { const dim = imageSize(buffer); width = dim.width ?? 0; height = dim.height ?? 0; } catch {}
                if (!width || !height) throw new Error(`Không đọc được kích thước ảnh ${baseName}`);
                return {
                    data: buffer,
                    filename: safeFilename,
                    metadata: { totalSize: buffer.length, width, height },
                };
            });
            const content: MessageContent = { msg: '', attachments };
            return await this.sendMessage(content as any, normalizedThreadId, threadType, null, quote);
        } catch (error: any) {
            throw new Error('sendImages error: ' + error.message);
        }
    }

    /**
     * Send a file from a local path
     */
    public async sendFile(filePath: string, threadId: string, type: ThreadType = ThreadType.User, quote: any = null): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try {
            const content: MessageContent = { msg: '', attachments: [filePath] };
            return await this.sendMessage(content as any, threadId, type, null, quote);
        } catch (error: any) {
            throw new Error('sendFile error: ' + error.message);
        }
    }

    /**
     * Get the message history (group), or return empty (user - not supported in the API)
     */
    public async getMessageHistory(threadId: string, type: number, lastMsgId?: string, count?: number): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        if (type === 1) {
            try {
                return await this.api.getGroupChatHistory(threadId, count ?? 500);
            } catch (error: any) {
                // zca-js can throw a SyntaxError when the JSON response is truncated
                if (error instanceof SyntaxError) {
                    throw new Error(tr('Không thể tải tin nhắn nhóm (lỗi phản hồi từ Zalo): {{message}}', { message: error.message }));
                }
                throw error;
            }
        }
        return { data: [] };
    }

    /**
     * Pin/unpin conversation
     * conversations can be string[], string, or [{threadId, type}] objects
     */
    public async setPinConversations(
        conversations: Array<{ threadId: string; type: number }> | string | string[],
        isPin: boolean
    ): Promise<SetPinnedConversationsResponse> {
        if (!this.api) throw new Error("API not initialized");
        let threadIds: string[];
        let threadType: any = 0; // ThreadType.User default
        if (Array.isArray(conversations) && conversations.length > 0 && typeof conversations[0] === 'object' && conversations[0] !== null) {
            const convObjs = conversations as Array<{ threadId: string; type: number }>;
            threadIds = convObjs.map(c => String(c.threadId));
            threadType = convObjs[0].type ?? 0;
        } else if (Array.isArray(conversations)) {
            threadIds = (conversations as string[]).map(String);
        } else {
            threadIds = [String(conversations)];
        }
        return await this.api.setPinnedConversations(isPin, threadIds, threadType);
    }

    public async getGroupChatHistory(groupId: string, count: number = 500): Promise<GetGroupChatHistoryResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        try {
            return await this.api.getGroupChatHistory(groupId, count);
        } catch (error: any) {
            if (error instanceof SyntaxError) {
                throw new Error(tr('Không thể tải tin nhắn nhóm (lỗi phản hồi từ Zalo): {{message}}', { message: error.message }));
            }
            throw error;
        }
    }

    public async updateArchivedChatList(isArchived: any, conversationsData: string): Promise<UpdateArchivedChatListResponse> {
         if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        let dataUpdate: UpdateArchivedChatListTarget[] = [],
            conversationArray = JSON.parse(conversationsData);

        conversationArray.forEach((item: any) => {
            dataUpdate.push({
                id: item.id,
                type: item.thread == 1 ? ThreadType.Group : ThreadType.User,
            });
        });

        try {
            return await this.api.updateArchivedChatList(isArchived == 1, dataUpdate);
        } catch (error) {
            throw error;
        }
    }

    public async sendBankCard(payload: string | Object, threadId: string, type: any = ThreadType.User): Promise<SendBankCardResponse> {        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }

        const parsedPayload = typeof payload == 'string' ? JSON.parse(payload) : payload,
            binBank = parsedPayload.binBank || '',
            numAccBank = parsedPayload.numAccBank || '',
            nameAccBank = parsedPayload.nameAccBank || ''
        if (!binBank || !numAccBank) {
            throw new Error("Invalid payload: empty array");
        }

        const finalPayload: SendBankCardPayload = {
            binBank: parseInt(binBank),
            numAccBank,
            nameAccBank,
        }

        try {
            return await this.api.sendBankCard(finalPayload, threadId, type);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Send the message-read event (seen event) to Zalo
     */
    public async sendSeenEvent(messages: any[], type: any = ThreadType.User): Promise<SendSeenEventResponse> {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.sendSeenEvent(messages, type);
        } catch (error) {
            throw error;
        }
    }

    public async addGroupDeputy(userId: string | string[], groupId: string): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).addGroupDeputy(userId, groupId); } catch (error) { throw error; }
    }

    public async removeGroupDeputy(userId: string | string[], groupId: string): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).removeGroupDeputy(userId, groupId); } catch (error) { throw error; }
    }

    public async changeGroupOwner(userId: string, groupId: string): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).changeGroupOwner(userId, groupId); } catch (error) { throw error; }
    }

    public async getGroupMembersInfo(groupId: string, memberIds?: string[]): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try {
            const ids = memberIds && memberIds.length > 0 ? memberIds : [groupId];
            return await (this.api as any).getGroupMembersInfo(ids);
        } catch (error) { throw error; }
    }

    public async addGroupBlockedMember(userId: string | string[], groupId: string): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).addGroupBlockedMember(userId, groupId); } catch (error) { throw error; }
    }

    public async removeGroupBlockedMember(userId: string | string[], groupId: string): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).removeGroupBlockedMember(userId, groupId); } catch (error) { throw error; }
    }

    public async getGroupBlockedMember(groupId: string): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).getGroupBlockedMember(groupId); } catch (error) { throw error; }
    }

    public async inviteUserToGroups(userId: string, groupIds: string[]): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).inviteUserToGroups(userId, groupIds); } catch (error) { throw error; }
    }

    public async addUnreadMark(threadId: string, type?: ThreadType): Promise<AddUnreadMarkResponse> {
        if (!this.api) throw new Error("API not initialized");
        const t = convertThreadType(type);
        try { return await (this.api as any).addUnreadMark(threadId, t); } catch (error) { throw error; }
    }

    public async removeUnreadMark(threadId: string, type?: ThreadType): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        const t = convertThreadType(type);
        try { return await (this.api as any).removeUnreadMark(threadId, t); } catch (error) { throw error; }
    }

    public async createPoll(options: {
        question: string;
        options: string[];
        expiredTime?: number;
        allowMultiChoices?: boolean;
        allowAddNewOption?: boolean;
        hideVotePreview?: boolean;
        isAnonymous?: boolean;
    }, groupId: string): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).createPoll(options, groupId); } catch (error) { throw error; }
    }

    public async getPollDetail(pollId: string): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).getPollDetail(pollId); } catch (error) { throw error; }
    }

    public async lockPoll(pollId: number): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).lockPoll(pollId); } catch (error) { throw error; }
    }

    public async doVotePoll(pollId: number, optionIds: number[]): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).votePoll(pollId, optionIds); } catch (error) { throw error; }
    }

    public async addPollOption(pollId: number, option: string): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try {
            return await (this.api as any).addPollOptions({
                pollId,
                options: [{ voted: false, content: option }],
                votedOptionIds: [],
            });
        } catch (error) { throw error; }
    }

    // ─── Quick messages ──────────────────────────────────────────────────────
    public async getQuickMessageList(): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).getQuickMessageList(); } catch (error) { throw error; }
    }

    public async addQuickMessage(payload: { keyword: string; title: string; mediaPath?: string }): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try {
            const addPayload: any = { keyword: payload.keyword, title: payload.title };
            if (payload.mediaPath) addPayload.media = payload.mediaPath;
            return await (this.api as any).addQuickMessage(addPayload);
        } catch (error) { throw error; }
    }

    public async updateQuickMessage(payload: { keyword: string; title: string; mediaPath?: string }, itemId: number): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try {
            const updatePayload: any = { keyword: payload.keyword, title: payload.title };
            if (payload.mediaPath) updatePayload.media = payload.mediaPath;
            return await (this.api as any).updateQuickMessage(updatePayload, itemId);
        } catch (error) { throw error; }
    }

    public async removeQuickMessage(itemIds: number | number[]): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).removeQuickMessage(itemIds); } catch (error) { throw error; }
    }

    // ─── Group notes ────────────────────────────────────────────────────────
    public async createNote(options: { title: string; pinAct?: boolean }, groupId: string): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).createNote(options, groupId); } catch (error) { throw error; }
    }

    public async editNote(options: { title: string; topicId: string; pinAct?: boolean }, groupId: string): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).editNote(options, groupId); } catch (error) { throw error; }
    }

    // ─── Group member approval ───────────────────────────────────────────
    public async reviewPendingMemberRequest(payload: any, groupId: string): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        try { return await (this.api as any).reviewPendingMemberRequest(payload, groupId); } catch (error) { throw error; }
    }

    // ─── Access status (ZL-01) ─────────────────────────────────────
    /** Access status of a person (lastOnline + whether the friend is online; cached for 60 s, duplicate calls merged: zaloPresenceCache). */
    public async getPresence(userId: string, force: boolean = false): Promise<ZaloPresence> {
        if (!this.api) throw new Error("API not initialized");
        if (!userId) throw new Error(tr('Thiếu userId'));
        const api = this.api as any;
        return getZaloPresence(this.zaloId || '', String(userId), {
            lastOnline: (uid: string) => api.lastOnline(uid),
            getFriendOnlines: () => api.getFriendOnlines(),
        }, { force });
    }

    /**
     * Friends who are online (getFriendOnlines, cached 60 s): the green dot in the conversation list (ZL-01 phase 2).
     * Zalo returns 404 for this route → { supported: false } (the UI stops asking), no error is thrown.
     */
    public async getFriendOnlineIds(force: boolean = false): Promise<{ supported: boolean; userIds: string[] }> {
        if (!this.api) throw new Error("API not initialized");
        const api = this.api as any;
        return getZaloFriendOnlines(this.zaloId || '', { getFriendOnlines: () => api.getFriendOnlines() }, { force });
    }

    // ─── Auto-delete messages (ZL-05) ─────────────────────────────────────────
    /** Read the list of conversations with auto-delete turned on in Zalo, save it to the DB (replaces the whole set) → [{ threadId, ttl }]. */
    public async syncAutoDeleteChats(): Promise<Array<{ threadId: string; ttl: number }>> {
        if (!this.api) throw new Error("API not initialized");
        const res = await (this.api as any).getAutoDeleteChat();
        const ttls = applyZaloAutoDeleteList(this.zaloId || '', res);
        return Array.from(ttls, ([threadId, ttl]) => ({ threadId, ttl }));
    }

    /** Turn auto-delete of messages in one conversation on or off in Zalo (ttl ms: 0 | 1 | 7 | 14 days); Deplao still keeps the messages. */
    public async setAutoDeleteChat(ttl: number, threadId: string, type?: ThreadType | number): Promise<{ ttl: number }> {
        if (!this.api) throw new Error("API not initialized");
        if (!threadId) throw new Error(tr('Thiếu threadId'));
        if (!isZaloAutoDeleteTtl(ttl)) throw new Error(tr('Thời gian tự xoá không hợp lệ (Tắt / 1 / 7 / 14 ngày)'));
        await (this.api as any).updateAutoDeleteChat(ttl, threadId, convertThreadType(type as any));
        applyZaloAutoDeleteOne(this.zaloId || '', String(threadId), ttl);
        return { ttl };
    }

    // ─── Privacy settings (ZL-02) ──────────────────────────────────
    /** Zalo account settings (getSettings): read fresh every time, not cached. */
    public async getAccountSettings(): Promise<any> {
        if (!this.api) throw new Error("API not initialized");
        return await (this.api as any).getSettings();
    }

    /** Change one setting (updateSettings): only keys / values from shared/zalo/zaloPrivacySettings. Logs old → new. */
    public async updateAccountSetting(key: string, value: number, previous?: unknown): Promise<{ key: string; value: number }> {
        if (!this.api) throw new Error("API not initialized");
        if (!isValidZaloSettingValue(key, value)) throw new Error(tr('Cài đặt không hợp lệ: {{key}} = {{value}}', { key, value }));
        await (this.api as any).updateSettings(key, value);
        Logger.log(`[ZaloSettings] ${this.zaloId}: ${key} ${previous ?? '?'} → ${value}`);
        return { key, value };
    }

    // ─── PIN-hidden conversations (ZL-03): the MD5 of the PIN never leaves main ──────
    /** Whether a PIN is set / number of hidden conversations; not read yet in this session or `force` → read from Zalo. */
    public async hiddenConversationStatus(force: boolean = false): Promise<HiddenStatus> {
        if (!this.api) throw new Error("API not initialized");
        const zaloId = this.zaloId || '';
        const known = hiddenStatus(zaloId);
        if (known.known && !force) return known;
        return syncZaloHidden(zaloId, zaloHiddenApiOf(this.api));
    }

    /** Compare the 4 digits typed in the search box with the PIN (5 wrong tries per minute → paused for 30 s). */
    public async unlockHiddenConversations(pin: string): Promise<UnlockResult> {
        if (!this.api) throw new Error("API not initialized");
        return unlockZaloHidden(this.zaloId || '', String(pin || ''), zaloHiddenApiOf(this.api));
    }

    /** Hide / unhide a conversation on Zalo (type 1 = group). */
    public async setConversationHidden(threadId: string, type: any, hidden: boolean): Promise<HiddenStatus> {
        if (!this.api) throw new Error("API not initialized");
        return setZaloConversationHidden(this.zaloId || '', String(threadId || ''), Number(type) === 1, !!hidden, zaloHiddenApiOf(this.api));
    }

    /** Set / change the PIN (if a PIN exists, the old PIN must be correct). */
    public async setHiddenConversationPin(pin: string, oldPin?: string): Promise<HiddenStatus> {
        if (!this.api) throw new Error("API not initialized");
        return setZaloHiddenPin(this.zaloId || '', String(pin || ''), oldPin ? String(oldPin) : undefined, zaloHiddenApiOf(this.api));
    }

    /** Forgot PIN → reset it on Zalo (Zalo may delete the messages of the hidden conversations on the Zalo device; Deplao keeps the messages). */
    public async resetHiddenConversationPin(): Promise<HiddenStatus> {
        if (!this.api) throw new Error("API not initialized");
        return resetZaloHiddenPin(this.zaloId || '', zaloHiddenApiOf(this.api));
    }

    // ─── Zalo Business product catalog (ZL-04) ─────────────────────────
    /** One page of the catalog (getCatalogList). */
    public async getCatalogs(page: number = 0, limit: number = 20): Promise<{ items: ZaloCatalog[]; hasMore: boolean }> {
        if (!this.api) throw new Error("API not initialized");
        const res = await (this.api as any).getCatalogList({ limit: Math.min(50, Math.max(1, limit)), page: Math.max(0, page) });
        return { items: (Array.isArray(res?.items) ? res.items : []).map(mapZaloCatalog), hasMore: Number(res?.has_more) === 1 };
    }

    public async createCatalog(name: string): Promise<ZaloCatalog> {
        if (!this.api) throw new Error("API not initialized");
        const clean = String(name || '').trim();
        if (!clean) throw new Error(tr('Nhập tên danh mục'));
        const res = await (this.api as any).createCatalog(clean);
        return mapZaloCatalog(res?.item);
    }

    public async updateCatalog(catalogId: string, name: string): Promise<ZaloCatalog> {
        if (!this.api) throw new Error("API not initialized");
        const clean = String(name || '').trim();
        if (!catalogId || !clean) throw new Error(tr('Thiếu danh mục hoặc tên'));
        const res = await (this.api as any).updateCatalog({ catalogId, catalogName: clean });
        return mapZaloCatalog(res?.item);
    }

    public async deleteCatalog(catalogId: string): Promise<{ deleted: true }> {
        if (!this.api) throw new Error("API not initialized");
        if (!catalogId) throw new Error(tr('Thiếu danh mục'));
        await (this.api as any).deleteCatalog(catalogId);
        return { deleted: true };
    }

    /** One page of products in the catalog (getProductCatalogList). */
    public async getCatalogProducts(catalogId: string, page: number = 0, limit: number = 100): Promise<{ items: ZaloProduct[]; hasMore: boolean }> {
        if (!this.api) throw new Error("API not initialized");
        if (!catalogId) throw new Error(tr('Thiếu danh mục'));
        const res = await (this.api as any).getProductCatalogList({ catalogId, limit: Math.min(100, Math.max(1, limit)), page: Math.max(0, page) });
        return { items: (Array.isArray(res?.items) ? res.items : []).map(mapZaloProduct), hasMore: Number(res?.has_more) === 1 };
    }

    /** Create a product: the photo is a URL already uploaded with uploadProductPhoto (zca-js 2.2.0 ignores `files`). */
    public async createCatalogProduct(input: { catalogId: string; name: string; price: string; description?: string; photos?: string[] }): Promise<ZaloProduct> {
        if (!this.api) throw new Error("API not initialized");
        const problem = !input?.catalogId ? tr('Thiếu danh mục') : validateZaloProduct(input);
        if (problem) throw new Error(problem);
        const res = await (this.api as any).createProductCatalog({
            catalogId: String(input.catalogId), productName: String(input.name).trim(), price: normalizeProductPrice(input.price),
            description: String(input.description || '').trim(), product_photos: (input.photos || []).map(String).slice(0, ZALO_PRODUCT_MAX_PHOTOS),
        });
        return mapZaloProduct(res?.item);
    }

    /** Edit a product: the original createTime must be sent again. */
    public async updateCatalogProduct(input: { catalogId: string; productId: string; name: string; price: string; description?: string; photos?: string[]; createTime?: number }): Promise<ZaloProduct> {
        if (!this.api) throw new Error("API not initialized");
        const problem = !input?.catalogId || !input?.productId ? tr('Thiếu danh mục hoặc sản phẩm') : validateZaloProduct(input);
        if (problem) throw new Error(problem);
        const res = await (this.api as any).updateProductCatalog({
            catalogId: String(input.catalogId), productId: String(input.productId), productName: String(input.name).trim(),
            price: normalizeProductPrice(input.price), description: String(input.description || '').trim(),
            createTime: Number(input.createTime) || Date.now(), product_photos: (input.photos || []).map(String).slice(0, ZALO_PRODUCT_MAX_PHOTOS),
        });
        return mapZaloProduct(res?.item);
    }

    public async deleteCatalogProducts(catalogId: string, productIds: string[]): Promise<{ deleted: number }> {
        if (!this.api) throw new Error("API not initialized");
        const ids = (productIds || []).map(String).filter(Boolean);
        if (!catalogId || ids.length === 0) throw new Error(tr('Thiếu danh mục hoặc sản phẩm'));
        await (this.api as any).deleteProductCatalog({ catalogId, productIds: ids });
        return { deleted: ids.length };
    }

    /** Upload one product photo to Zalo → URL used for product_photos. */
    public async uploadProductPhoto(photoPath: string): Promise<{ url: string; thumbUrl: string }> {
        if (!this.api) throw new Error("API not initialized");
        if (!photoPath) throw new Error(tr('Thiếu ảnh'));
        const res = await (this.api as any).uploadProductPhoto({ file: photoPath });
        const url = res?.normalUrl || res?.hdUrl || '';
        if (!url) throw new Error(tr('Zalo không trả link ảnh'));
        return { url, thumbUrl: res?.thumbUrl || url };
    }
}
