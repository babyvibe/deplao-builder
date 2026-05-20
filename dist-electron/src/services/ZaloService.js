"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const zca_js_1 = require("zca-js");
const axios_1 = __importDefault(require("axios"));
const path_1 = __importDefault(require("path"));
const fs = __importStar(require("node:fs"));
const ConnectionManager_1 = __importDefault(require("../utils/ConnectionManager"));
const image_size_1 = require("image-size");
const Utils_1 = require("../utils/Utils");
const Logger_1 = __importDefault(require("../utils/Logger"));
class ZaloService {
    /**
     * Khởi tạo một đối tượng ZaloService mới
     * @param auth ID Zalo của người dùng
     */
    constructor(auth) {
        this.zaloId = null;
        this.auth = auth;
    }
    /**
     * Lấy hoặc tạo một instance của ZaloService
     * @returns Promise<ZaloService> Instance của ZaloService
     * @param auth
     * @param isReconnection Whether this is a reconnection (force delete old connection and create new)
     */
    static async getInstance(auth, isReconnection = false) {
        const parsedAuth = JSON.parse(auth);
        const key = Buffer.from(parsedAuth.cookies).toString('base64');
        // If reconnection, remove existing instance to force recreation
        // Nếu reconnection, xóa instance hiện có để buộc tạo lại
        if (isReconnection && this.instances.has(key)) {
            Logger_1.default.log(`[${new Date().toISOString()}] [ZaloService] 🔄 Reconnection: Removing existing ZaloService instance`);
            this.instances.delete(key);
        }
        if (!this.instances.has(key)) {
            const instance = new ZaloService(parsedAuth);
            await instance.initialize(isReconnection);
            this.instances.set(key, instance);
        }
        return this.instances.get(key);
    }
    /**
     * Remove a ZaloService instance by zaloId (called when account is disconnected/removed).
     * Prevents stale API instances from accumulating in memory.
     */
    static removeInstanceByZaloId(zaloId) {
        for (const [key, instance] of this.instances) {
            if (instance.zaloId === zaloId) {
                this.instances.delete(key);
                Logger_1.default.log(`[ZaloService] 🗑️ Removed instance for zaloId=${zaloId}`);
                return;
            }
        }
    }
    /**
     * Khởi tạo API Zalo cho instance hiện tại
     * SỬ DỤNG ConnectionManager làm single source of truth
     * API-only mode: không start listener (chỉ dùng cho gọi API)
     * @param isReconnection Whether this is a reconnection (force delete old connection and create new)
     */
    async initialize(isReconnection = false) {
        Logger_1.default.log(`[${new Date().toISOString()}] [ZaloService] Initializing${isReconnection ? ' (reconnection mode)' : ''}...`);
        // GET API FROM CONNECTION MANAGER (not create new!)
        // Pass startListener=false for API-only operations (no WebSocket listener)
        // Pass isReconnection to force recreation if needed
        // LẤY API TỪ CONNECTION MANAGER (không tạo mới!)
        // Truyền startListener=false cho các thao tác chỉ dùng API (không có listener WebSocket)
        // Truyền isReconnection để buộc tạo lại nếu cần
        const connection = await ConnectionManager_1.default.getOrCreateConnection(this.auth, false, undefined, isReconnection);
        this.api = connection.api;
        this.zaloId = this.api.getOwnId();
        Logger_1.default.log(`[${new Date().toISOString()}] [ZaloService] ✅ Initialized for ${this.zaloId} - Using shared API instance from ConnectionManager (API-only mode, no listener)`);
    }
    /**
     * Lấy Zalo ID của người dùng hiện tại
     */
    getZaloId() {
        return this.zaloId;
    }
    /**
     * Gửi tin nhắn
     * @param message Nội dung tin nhắn (chuỗi hoặc đối tượng MessageContent)
     * @param threadId ID của cuộc trò chuyện
     * @param type Loại tin nhắn (tùy chọn)
     * @param typeMessage Loại tin nhắn đặc biệt (tùy chọn, ví dụ: 'file',...)
     * @param quote Tin nhắn trích dẫn (tùy chọn)
     * @param mentions Tag all hoặc tag member trong 1 group
     * @param styles định dạng văn bản
     * @returns Promise chứa kết quả gửi tin nhắn và tệp đính kèm
     */
    async sendMessage(message, threadId, type, typeMessage = null, quote = null, mentions = null, styles = null) {
        let filesPath = [];
        try {
            if (!this.api) {
                throw new Error("API not initialized. Please ensure you've called initialize() first.");
            }
            let messageContent;
            // ALWAYS use API from ConnectionManager for consistency
            // LUÔN sử dụng API từ ConnectionManager để đảm bảo tính nhất quán
            const zaloId = this.api.getOwnId();
            const connection = ConnectionManager_1.default.getConnection(zaloId);
            const apiSending = connection?.api || this.api;
            Logger_1.default.log(`[${new Date().toISOString()}] [ZaloService] 📤 Sending message using ${connection ? 'ConnectionManager API' : 'local API'}`);
            if (typeof message === 'string') {
                messageContent = { msg: message };
            }
            else {
                if (typeMessage == 'file') {
                    if (!message?.attachments || message?.attachments.length === 0) {
                        throw new Error("No attachments provided for file type message");
                    }
                    filesPath = await this.handleDownloadAttachments(message.attachments);
                    // Đọc metadata nếu là ảnh
                    // nếu không phải ảnh thì gửi thẳng file url
                    message.attachments = filesPath.map(filePath => {
                        let attachment;
                        if ((0, Utils_1.isImageFile)(filePath)) {
                            const buffer = fs.readFileSync(filePath);
                            const baseName = path_1.default.basename(filePath);
                            const metadata = { totalSize: buffer.length };
                            try {
                                const { width, height } = (0, image_size_1.imageSize)(buffer);
                                metadata.width = width ?? 0;
                                metadata.height = height ?? 0;
                                attachment = {
                                    data: buffer,
                                    filename: baseName,
                                    metadata: metadata,
                                };
                            }
                            catch (err) {
                                console.warn(`⚠️ Không đọc được kích thước ảnh: ${filePath}`, err);
                            }
                        }
                        else {
                            attachment = filePath;
                        }
                        return attachment;
                    });
                    messageContent = message;
                }
                else {
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
                const isGroupThread = (type === zca_js_1.ThreadType.Group || type === 1);
                let quoteContent = quoteData.content;
                let quoteMsgType = quoteData.msgType || 'webchat';
                // ── Chuẩn hoá msgType cho từng loại ────────────────────────────────
                // chat.recommended / chat.link = link được share (Facebook, web, ...)
                // Real Zalo dùng cliMsgType=1 (webchat) + qmsg=JSON string content
                // Nếu để nguyên 'chat.recommended' → getClientMessageType() = 38
                // → Zalo hiển thị "[danh thiếp] undefined" vì 38 = card type
                if (quoteMsgType === 'chat.recommended' || quoteMsgType === 'chat.link') {
                    quoteMsgType = 'webchat';
                }
                // ── Stringify content cho individual chat ───────────────────────────
                // zca-js:  qmsg = typeof content == "string" ? content : prepareQMSG(content)
                // prepareQMSG() trả về "" cho mọi loại trừ chat.todo
                // → Nếu content là object, qmsg="" → Zalo không hiển thị được quote
                //
                // Real Zalo (evidence từ webhook log):
                //   text  : cliMsgType=1,  qmsg="the text"
                //   link  : cliMsgType=1,  qmsg=JSON string of TAttachmentContent
                //   file  : cliMsgType=46, qmsg=JSON string of TAttachmentContent
                //
                // → Individual: stringify để qmsg nhận được JSON string ✓
                // → Group: giữ object để prepareQMSGAttach() build qmsgAttach đúng ✓
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
        }
        catch (error) {
            throw new Error("Error sending message: " + error.message || error);
        }
        finally {
            // Xóa các file tạm thời sau khi gửi
            if (filesPath.length > 0) {
                await this.deleteTemporaryFiles(filesPath);
            }
        }
    }
    /**
     * Gửi sticker
     * @param stickerId ID của sticker cần gửi
     * @param threadId ID của người/nhóm cần gửi
     * @param type Loại thread: người dùng/nhóm (mặc định là người dùng)
     * @returns Promise chứa kết quả gửi sticker
     */
    async sendSticker(stickerId, threadId, type = zca_js_1.ThreadType.User) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            // Lấy chi tiết sticker
            const stickersDetail = await this.api.getStickersDetail(stickerId);
            if (stickersDetail.length === 0) {
                throw new Error("Sticker not found");
            }
            // Gửi sticker
            return await this.api.sendSticker(stickersDetail[0], threadId, type);
        }
        catch (error) {
            throw new Error("Error sending sticker: " + error.message || error);
        }
    }
    /**
     * Thêm biểu tượng cảm xúc (reaction) vào tin nhắn
     * @param reaction Biểu tượng cảm xúc cần thêm (thuộc enum Reactions)
     * @param message Đối tượng Message cần thêm biểu tượng cảm xúc
     * @returns Promise<AddReactionResponse>
     */
    async addReaction(reaction, message) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            const parsedMessage = JSON.parse(message);
            const msgId = String(parsedMessage.data?.msgId || parsedMessage.msgId || '0');
            // cliMsgId MUST be a parseable integer — fallback to msgId if missing/empty
            const rawCliMsgId = parsedMessage.data?.cliMsgId || parsedMessage.cliMsgId;
            const cliMsgId = (rawCliMsgId && String(rawCliMsgId) !== '' && String(rawCliMsgId) !== 'undefined')
                ? String(rawCliMsgId)
                : msgId;
            const dest = {
                data: { msgId, cliMsgId },
                threadId: String(parsedMessage.threadId || ''),
                type: parsedMessage.type ?? 0,
            };
            return await this.api.addReaction(zca_js_1.Reactions[reaction], dest);
        }
        catch (error) {
            throw new Error("Error sending reaction: " + (error.message || error));
        }
    }
    /**
     * Xử lý tải xuống các tệp đính kèm
     * @param attachments Mảng các URL của tệp đính kèm
     * @returns Promise<string[]> Mảng đường dẫn của các tệp đã tải xuống
     */
    async handleDownloadAttachments(attachments) {
        const downloadedFiles = [];
        const imageDir = path_1.default.join(__dirname, '..', '..', 'data', 'image_message');
        // Đảm bảo thư mục tồn tại
        if (!fs.existsSync(imageDir)) {
            fs.mkdirSync(imageDir, { recursive: true });
        }
        for (const fileUrl of attachments) {
            try {
                let filePath = '';
                const u = new URL(fileUrl);
                const timestamp = Date.now();
                const randomString = this.generateRandomString(5);
                const fileName = this.getFileNameFromUrl(fileUrl);
                //  TH gửi file, tạo hẳn folder tạm để giữ tên file nguyên bản
                if (u.searchParams.get("name")) {
                    // Tạo folder tạm
                    const folderPathCreated = path_1.default.join(imageDir, `${timestamp}_${randomString}`);
                    fs.mkdirSync(folderPathCreated, { recursive: true });
                    filePath = path_1.default.join(folderPathCreated, `${fileName}`);
                }
                else {
                    filePath = path_1.default.join(imageDir, `${timestamp}_${randomString}_${fileName}`);
                }
                const response = await (0, axios_1.default)({
                    method: 'GET',
                    url: fileUrl,
                    responseType: 'stream'
                });
                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);
                await new Promise((resolve, reject) => {
                    writer.on('finish', () => resolve());
                    writer.on('error', reject);
                });
                downloadedFiles.push(filePath);
            }
            catch (error) {
                // console.error(`Error downloading file from ${fileUrl}:`, error);
            }
        }
        return downloadedFiles;
    }
    getFileNameFromUrl(url) {
        const u = new URL(url);
        return u.searchParams.get("name") || path_1.default.basename(u.pathname);
    }
    /**
     * Tạo chuỗi ngẫu nhiên
     * @param length Độ dài của chuỗi cần tạo
     * @returns string Chuỗi ngẫu nhiên
     */
    generateRandomString(length) {
        const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += characters.charAt(Math.floor(Math.random() * characters.length));
        }
        return result;
    }
    /**
     * Xóa các tệp tạm thời
     * @param filePaths Mảng đường dẫn của các tệp cần xóa
     * xóa cả folder tạm với trường hợp gửi file
     */
    async deleteTemporaryFiles(filePaths) {
        const baseFolder = path_1.default.join(__dirname, "..", "..", "data", "image_message");
        for (const filePath of filePaths) {
            try {
                await fs.promises.unlink(filePath);
                const folderPath = path_1.default.dirname(filePath);
                const relative = path_1.default.relative(baseFolder, folderPath);
                if (relative === "") {
                    // file nằm trực tiếp trong image_message -> chỉ xoá file
                }
                else if (!relative.startsWith("..") && !path_1.default.isAbsolute(relative)) {
                    // folderPath là con của baseFolder -> xoá luôn folder
                    await fs.promises.rmdir(folderPath, { recursive: true });
                }
            }
            catch (error) {
                // console.error(`Error deleting temporary file ${filePath}:`, error);
            }
        }
    }
    /**
     * Lấy danh sách sticker dựa trên từ khóa
     * @param keyword Từ khóa tìm kiếm sticker
     */
    async getStickers(keyword) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getStickers(keyword);
        }
        catch (error) {
            throw new Error("Error getting stickers: " + error.message || error);
        }
    }
    /**
     * Lấy chi tiết của các sticker dựa trên ID
     * @param stickerIds ID của sticker hoặc mảng các ID sticker cần lấy chi tiết
     */
    async getStickersDetail(stickerIds) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getStickersDetail(stickerIds);
        }
        catch (error) {
            throw new Error("Error getting sticker details: " + error.message || error);
        }
    }
    /**
     * Lấy tất cả sticker trong một category/pack
     * @param cateId ID category sticker
     */
    async getStickerCategoryDetail(cateId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getStickerCategoryDetail(cateId);
        }
        catch (error) {
            throw new Error("Error getting sticker category detail: " + error.message || error);
        }
    }
    /**
     * Thu hồi tin nhắn
     * @param message Đối tượng Message cần thu hồi
     * @returns Promise<UndoResponse>
     */
    async undoMessage(message) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            const parsedMessage = JSON.parse(message);
            const undoOptions = {
                msgId: parsedMessage.data.msgId,
                cliMsgId: parsedMessage.data.cliMsgId,
            };
            // Dùng convertThreadType để đảm bảo group dùng ThreadType.Group (1), user dùng ThreadType.User (0)
            const threadType = (0, Utils_1.convertThreadType)(parsedMessage.type);
            const uidFrom = parsedMessage.data?.uidFrom;
            Logger_1.default.log(`[ZaloService] undoMessage: msgId=${parsedMessage.data.msgId} threadId=${parsedMessage.threadId} type=${threadType}(raw=${parsedMessage.type})${uidFrom ? ` uidFrom=${uidFrom}` : ''}`);
            // Trưởng/phó nhóm thu hồi tin nhắn của thành viên — cần gửi uidFrom
            if (uidFrom && threadType === zca_js_1.ThreadType.Group) {
                return await this.adminRecallGroupMessage(undoOptions, parsedMessage.threadId, uidFrom);
            }
            return await this.api.undo(undoOptions, parsedMessage.threadId, threadType);
        }
        catch (error) {
            throw new Error("Error undoing message: " + (error.message || error));
        }
    }
    /**
     * Admin (trưởng/phó nhóm) thu hồi tin nhắn của thành viên khác trong nhóm.
     * Dùng deleteMessage(onlyMe=false) → xóa cho tất cả thành viên.
     * Endpoint /api/group/undomsg chỉ hỗ trợ người gửi tự thu hồi, không hỗ trợ admin thu hồi của người khác.
     */
    async adminRecallGroupMessage(payload, threadId, uidFrom) {
        if (!this.api)
            throw new Error("API not initialized");
        Logger_1.default.log(`[ZaloService] adminRecallGroupMessage: msgId=${payload.msgId} threadId=${threadId} uidFrom=${uidFrom}`);
        // deleteMessage với onlyMe=false xóa tin nhắn cho tất cả thành viên nhóm
        // Điều kiện: isSelf=false (admin != sender) nên không bị reject bởi zca-js
        return await this.api.deleteMessage({
            threadId,
            type: zca_js_1.ThreadType.Group,
            data: {
                msgId: String(payload.msgId),
                cliMsgId: String(payload.cliMsgId),
                uidFrom: String(uidFrom),
            },
        }, false);
    }
    /**
     * Xóa một hoặc nhiều thành viên khỏi nhóm
     * @param memberId ID của thành viên hoặc mảng các ID thành viên cần xóa khỏi nhóm
     * @param groupId ID của nhóm
     */
    async removeUserFromGroup(memberId, groupId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.removeUserFromGroup(memberId, groupId);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Thay đổi ảnh đại diện của nhóm
     * @param avatarPath Đường dẫn đến file ảnh đại diện mới
     * @param groupId ID của nhóm cần thay đổi ảnh đại diện
     */
    async changeGroupAvatar(avatarPath, groupId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.changeGroupAvatar(avatarPath, groupId);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Thay đổi tên nhóm
     * @param name Tên mới của nhóm
     * @param groupId ID của nhóm cần đổi tên
     */
    async changeGroupName(name, groupId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.changeGroupName(name, groupId);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Gửi yêu cầu kết bạn đến một người dùng Zalo
     * @param msg Nội dung tin nhắn kèm theo yêu cầu kết bạn
     * @param userId ID của người dùng mà bạn muốn gửi yêu cầu kết bạn
     */
    async sendFriendRequest(msg, userId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.sendFriendRequest(msg, userId);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Tìm kiếm người dùng Zalo dựa trên số điện thoại
     * @param phoneNumber Số điện thoại của người dùng cần tìm kiếm
     */
    async findUser(phoneNumber) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.findUser(phoneNumber);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Lấy danh sách tất cả bạn bè của người dùng hiện tại
     */
    async getAllFriends() {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getAllFriends();
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Lấy danh sách tất cả các nhóm mà người dùng hiện tại tham gia
     */
    async getAllGroups() {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getAllGroups();
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Xóa tin nhắn
     * @param message Đối tượng Message cần xóa
     * @param onlyMe Chỉ xóa tin nhắn cho bản thân (mặc định là true)
     */
    async deleteMessage(message, onlyMe = true) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        const parsedMessage = JSON.parse(message);
        let options = {
            data: {
                cliMsgId: parsedMessage.data.cliMsgId,
                msgId: parsedMessage.data.msgId,
                uidFrom: parsedMessage.data.uidFrom,
            },
            threadId: parsedMessage.threadId,
            type: parsedMessage.type
        };
        // if (parsedMessage.type === ThreadType.User) {
        //     message = new UserMessage(this.api.getOwnId(), parsedMessage.data);
        // } else if (parsedMessage.type === ThreadType.Group) {
        //     message = new GroupMessage(this.api.getOwnId(), parsedMessage.data);
        // }
        try {
            return await this.api.deleteMessage(options, onlyMe);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Xóa đoạn chat (ẩn hội thoại phía server)
     * @param lastMessage Thông tin tin nhắn cuối cùng trong hội thoại
     * @param threadId ID của hội thoại
     * @param type Loại hội thoại (User/Group)
     */
    async deleteChat(lastMessage, threadId, type = zca_js_1.ThreadType.User) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.deleteChat(lastMessage, threadId, type);
        }
        catch (error) {
            throw new Error("Error deleting chat: " + (error.message || error));
        }
    }
    /**
     * Tạo một nhóm mới trên Zalo
     * @param options Các tùy chọn để tạo nhóm, bao gồm thông tin như tên nhóm, danh sách thành viên, v.v.
     */
    async createGroup(options) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        let filesPath = [];
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
        }
        catch (error) {
            throw error;
        }
        finally {
            // Xóa các file tạm thời sau khi gửi
            if (filesPath.length > 0) {
                await this.deleteTemporaryFiles(filesPath);
            }
        }
    }
    async disperseGroup(groupId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.disperseGroup(groupId);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Chặn một người dùng Zalo
     * @param userId ID của người dùng cần chặn
     */
    async blockUser(userId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.blockUser(userId);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Lấy danh sách nhóm chung với một người dùng
     * @param userId ID của người dùng cần xem nhóm chung
     */
    async getRelatedFriendGroup(userId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getRelatedFriendGroup(userId);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Thêm một hoặc nhiều người dùng vào nhóm
     * @param memberId ID của thành viên hoặc mảng các ID thành viên cần thêm vào nhóm
     * @param groupId ID của nhóm
     */
    async addUserToGroup(memberId, groupId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.addUserToGroup(memberId, groupId);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Chấp nhận lời mời kết bạn từ một người dùng Zalo
     * @param userId ID của người dùng đã gửi lời mời kết bạn
     */
    async acceptFriendRequest(userId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.acceptFriendRequest(userId);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Bỏ chặn một người dùng Zalo
     * @param userId ID của người dùng cần bỏ chặn
     */
    async unblockUser(userId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.unblockUser(userId);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Lấy context của phiên đăng nhập hiện tại (uid, phone, loginInfo, ...)
     */
    getContext() {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        return this.api.getContext();
    }
    /**
     * Lấy thông tin của người dùng Zalo
     * @param userId ID của người dùng cần lấy thông tin
     */
    async getUserInfo(userId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getUserInfo(userId);
        }
        catch (error) {
            throw new Error(error.message || error);
        }
    }
    async getAliasList(count = 100, page = 1) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getAliasList(count, page);
        }
        catch (error) {
            throw new Error(error.message || error);
        }
    }
    /**
     * Gửi nhiều danh thiếp (cards) đến một hoặc nhiều người dùng hoặc nhóm
     * @param cardsInfo Mảng chứa thông tin về các danh thiếp cần gửi
     * @returns Promise<SendCardResponse[]>
     */
    async sendCard(cardsInfo) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            const sendPromises = cardsInfo.map(({ options, threadId, type = zca_js_1.ThreadType.User, quote }) => {
                if (!this.api) {
                    throw new Error("API became undefined during execution.");
                }
                const quoteParsed = quote ? (typeof quote === 'string' ? JSON.parse(quote) : quote) : null;
                const payload = quoteParsed ? { ...options, quote: quoteParsed } : options;
                return this.api.sendCard(payload, threadId, type);
            });
            return await Promise.all(sendPromises);
        }
        catch (error) {
            throw new Error("Error sending multiple cards: " + (error.message || error));
        }
    }
    /**
     * Lấy thông tin chi tiết của một nhóm hoặc nhiều nhóm
     * */
    async getGroupInfo(groupId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getGroupInfo(groupId);
        }
        catch (error) {
            throw new Error(`Error getting group info: ${error.message || error}`);
        }
    }
    async sendVideo(videoOptions, threadId, type, quote = null) {
        let filesPath = [];
        try {
            if (!this.api) {
                throw new Error("API not initialized. Please ensure you've called initialize() first.");
            }
            type = (0, Utils_1.convertThreadType)(type);
            const quoteParsed = quote ? (typeof quote === 'string' ? JSON.parse(quote) : quote) : null;
            const payload = quoteParsed ? { ...videoOptions, quote: quoteParsed } : videoOptions;
            return await this.api.sendVideo(payload, threadId, type);
        }
        catch (error) {
            throw new Error("Error sending video: " + error.message || error);
        }
        finally {
            // Xóa các file tạm thời sau khi gửi
            if (filesPath.length > 0) {
                await this.deleteTemporaryFiles(filesPath);
            }
        }
    }
    async keepAlive() {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.keepAlive();
        }
        catch (error) {
            throw new Error("Error keeping alive: " + error.message || error);
        }
    }
    async leaveGroup(groupId, silent = false) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.leaveGroup(groupId, silent);
        }
        catch (error) {
            throw error;
        }
    }
    async forwardMessage(message, threadIds, type) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        const parsedMessage = JSON.parse(message);
        let payload = {
            message: parsedMessage.data.content,
            // ttl: 60,
            // reference?: {
            //     id: string;
            //     ts: number;
            //     logSrcType: number;
            //     fwLvl: number;
            // };
        };
        type = (0, Utils_1.convertThreadType)(type);
        try {
            return await this.api.forwardMessage(payload, threadIds, type);
        }
        catch (error) {
            throw error;
        }
    }
    async sendLink(link, threadId, type, quote = null, message) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        const quoteParsed = quote ? (typeof quote === 'string' ? JSON.parse(quote) : quote) : null;
        let payload = {
            link
        };
        if (message && message.trim())
            payload.msg = message.trim();
        if (quoteParsed)
            payload.quote = quoteParsed;
        type = (0, Utils_1.convertThreadType)(type);
        try {
            return await this.api.sendLink(payload, threadId, type);
        }
        catch (error) {
            throw error;
        }
    }
    async pinConversation(pinned, threadId, type) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.setPinnedConversations(pinned, threadId, type);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Tắt/bật âm cuộc trò chuyện qua Zalo API
     * @param threadId ID hội thoại
     * @param threadType 0=User (mặc định), 1=Group
     * @param duration MuteDuration hoặc giây; undefined = unmute
     * @param action MuteAction.MUTE (1) hoặc MuteAction.UNMUTE (3)
     */
    async setMute(threadId, threadType, duration, action = zca_js_1.MuteAction.MUTE) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        const type = threadType === 1 ? zca_js_1.ThreadType.Group : zca_js_1.ThreadType.User;
        try {
            return await this.api.setMute({ duration, action }, threadId, type);
        }
        catch (error) {
            throw error;
        }
    }
    async getGroupLinkDetail(groupId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getGroupLinkDetail(groupId);
        }
        catch (error) {
            throw error;
        }
    }
    async getGroupLinkInfo(link, memberPage = 1) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getGroupLinkInfo({ link, memberPage });
        }
        catch (error) {
            throw error;
        }
    }
    async enableGroupLink(groupId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.enableGroupLink(groupId);
        }
        catch (error) {
            throw error;
        }
    }
    async disableGroupLink(groupId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.disableGroupLink(groupId);
        }
        catch (error) {
            throw error;
        }
    }
    async updateGroupSettings(options, groupId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        const parsedOptions = JSON.parse(options);
        try {
            return await this.api.updateGroupSettings(parsedOptions, groupId);
        }
        catch (error) {
            throw error;
        }
    }
    async rejectFriendRequest(friendId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.rejectFriendRequest(friendId);
        }
        catch (error) {
            throw error;
        }
    }
    async getFriendRecommendations() {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getFriendRecommendations();
        }
        catch (error) {
            throw error;
        }
    }
    async getArchivedChatList() {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getArchivedChatList();
        }
        catch (error) {
            throw error;
        }
    }
    async setHiddenConversations(hidden, threadId, type) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        type = (0, Utils_1.convertThreadType)(type);
        try {
            return await this.api.setHiddenConversations(hidden == 1, threadId, type);
        }
        catch (error) {
            throw error;
        }
    }
    async getFriendRequestStatus(friendId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getFriendRequestStatus(friendId);
        }
        catch (error) {
            throw error;
        }
    }
    async getPinConversations() {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getPinConversations();
        }
        catch (error) {
            throw error;
        }
    }
    async getLabels() {
        if (!this.api)
            throw new Error("API not initialized.");
        try {
            return await this.api.getLabels();
        }
        catch (error) {
            throw new Error("Error getting labels: " + error.message);
        }
    }
    async updateLabels(labelData, version) {
        if (!this.api)
            throw new Error("API not initialized.");
        try {
            return await this.api.updateLabels({ labelData, version });
        }
        catch (error) {
            throw new Error("Error updating labels: " + error.message);
        }
    }
    async changeFriendAlias(alias, friendId) {
        if (!this.api)
            throw new Error("API not initialized.");
        try {
            return await this.api.changeFriendAlias(alias, friendId);
        }
        catch (error) {
            throw new Error("Error changing alias: " + error.message);
        }
    }
    async getReminder(reminderId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getReminder(reminderId);
        }
        catch (error) {
            throw error;
        }
    }
    async sendVoice(voiceOptions, threadId, type, quote = null) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        const quoteParsed = quote ? (typeof quote === 'string' ? JSON.parse(quote) : quote) : null;
        type = (0, Utils_1.convertThreadType)(type);
        try {
            const payload = quoteParsed ? { ...voiceOptions, quote: quoteParsed } : voiceOptions;
            return await this.api.sendVoice(payload, threadId, type);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Upload file âm thanh lên server Zalo
     * Trả về fileUrl để dùng trong sendVoice.voiceUrl
     */
    async uploadVoiceFile(voicePath, threadId, type) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            const threadType = (0, Utils_1.convertThreadType)(type);
            const result = await this.api.uploadAttachment([voicePath], threadId, threadType);
            const resp = Array.isArray(result) ? result[0] : result;
            Logger_1.default.info(`[ZaloService] uploadVoiceFile raw result: ${JSON.stringify(resp)}`);
            return resp;
        }
        catch (error) {
            throw new Error('uploadVoiceFile error: ' + error.message);
        }
    }
    async createReminder(reminderOptions, threadId, type) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        type = (0, Utils_1.convertThreadType)(type);
        try {
            return await this.api.createReminder(reminderOptions, threadId, type);
        }
        catch (error) {
            throw error;
        }
    }
    async editReminder(reminderOptions, threadId, type) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        type = (0, Utils_1.convertThreadType)(type);
        try {
            return await this.api.editReminder(reminderOptions, threadId, type);
        }
        catch (error) {
            throw error;
        }
    }
    async removeReminder(reminderId, threadId, type) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        type = (0, Utils_1.convertThreadType)(type);
        try {
            return await this.api.removeReminder(reminderId, threadId, type);
        }
        catch (error) {
            throw error;
        }
    }
    async getListReminder(options, threadId, type) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        type = (0, Utils_1.convertThreadType)(type);
        try {
            return await this.api.getListReminder(options, threadId, type);
        }
        catch (error) {
            throw error;
        }
    }
    async getReminderResponses(reminderId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getReminderResponses(reminderId);
        }
        catch (error) {
            throw error;
        }
    }
    async removeFriendAlias(friendId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.removeFriendAlias(friendId);
        }
        catch (error) {
            throw error;
        }
    }
    async removeFriend(friendId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            await this.api.removeFriend(friendId);
            return { success: true };
        }
        catch (error) {
            throw error;
        }
    }
    async getPendingGroupMembers(groupId) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getPendingGroupMembers(groupId);
        }
        catch (error) {
            throw error;
        }
    }
    async getSentFriendRequest() {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getSentFriendRequest();
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Lấy URL proxy đang được sử dụng cho kết nối Zalo hiện tại
     * @returns The proxy URL or null if not assigned
     */
    getProxyUrl() {
        return null; // No proxy in desktop mode
    }
    /**
     * Gửi ảnh từ local file path
     */
    async sendImage(filePath, threadId, type = zca_js_1.ThreadType.User, caption, quote = null) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            const buffer = fs.readFileSync(filePath);
            const baseName = path_1.default.basename(filePath);
            let width = 0, height = 0;
            try {
                const dim = (0, image_size_1.imageSize)(buffer);
                width = dim.width ?? 0;
                height = dim.height ?? 0;
            }
            catch { }
            const attachment = {
                data: buffer,
                filename: baseName,
                metadata: { totalSize: buffer.length, width, height },
            };
            const content = { msg: caption || '', attachments: [attachment] };
            return await this.sendMessage(content, threadId, type, null, quote);
        }
        catch (error) {
            throw new Error('sendImage error: ' + error.message);
        }
    }
    /**
     * Upload thumbnail ảnh đại diện của video lên server Zalo
     * Trả về URL để dùng trong sendVideo.thumbnailUrl
     */
    async uploadVideoThumb(thumbPath, threadId, type) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            const threadType = (0, Utils_1.convertThreadType)(type);
            const result = await this.api.uploadAttachment([thumbPath], threadId, threadType);
            const resp = Array.isArray(result) ? result[0] : result;
            Logger_1.default.info(`[ZaloService] uploadVideoThumb raw result: ${JSON.stringify(resp)}`);
            return resp;
        }
        catch (error) {
            throw new Error('uploadVideoThumb error: ' + error.message);
        }
    }
    /**
     * Upload file video lên server Zalo
     * Trả về fileUrl để dùng trong sendVideo.videoUrl
     */
    async uploadVideoFile(videoPath, threadId, type) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            const threadType = (0, Utils_1.convertThreadType)(type);
            const result = await this.api.uploadAttachment([videoPath], threadId, threadType);
            const resp = Array.isArray(result) ? result[0] : result;
            Logger_1.default.info(`[ZaloService] uploadVideoFile raw result: ${JSON.stringify(resp)}`);
            return resp;
        }
        catch (error) {
            throw new Error('uploadVideoFile error: ' + error.message);
        }
    }
    /**
     * Gửi nhiều ảnh trong một tin nhắn (dùng groupLayoutId của zca-js)
     */
    async sendImages(filePaths, threadId, type = zca_js_1.ThreadType.User, quote = null) {
        if (!this.api)
            throw new Error("API not initialized");
        if (!filePaths.length)
            return [];
        // Nếu chỉ 1 ảnh, dùng sendImage thông thường
        if (filePaths.length === 1)
            return this.sendImage(filePaths[0], threadId, type, undefined, quote);
        try {
            const attachments = filePaths.map(filePath => {
                const buffer = fs.readFileSync(filePath);
                const baseName = path_1.default.basename(filePath);
                // zca-js requires filename to contain an extension (`${string}.${string}`)
                const ext = path_1.default.extname(baseName) || '.jpg';
                const safeFilename = (path_1.default.extname(baseName) ? baseName : `${baseName}${ext}`);
                let width = 0, height = 0;
                try {
                    const dim = (0, image_size_1.imageSize)(buffer);
                    width = dim.width ?? 0;
                    height = dim.height ?? 0;
                }
                catch { }
                return {
                    data: buffer,
                    filename: safeFilename,
                    metadata: { totalSize: buffer.length, width, height },
                };
            });
            const content = { msg: '', attachments };
            return await this.sendMessage(content, threadId, type, null, quote);
        }
        catch (error) {
            throw new Error('sendImages error: ' + error.message);
        }
    }
    /**
     * Gửi file từ local path
     */
    async sendFile(filePath, threadId, type = zca_js_1.ThreadType.User, quote = null) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            const content = { msg: '', attachments: [filePath] };
            return await this.sendMessage(content, threadId, type, null, quote);
        }
        catch (error) {
            throw new Error('sendFile error: ' + error.message);
        }
    }
    /**
     * Lấy lịch sử tin nhắn (group) hoặc trả về rỗng (user - không hỗ trợ trong API)
     */
    async getMessageHistory(threadId, type, lastMsgId, count) {
        if (!this.api)
            throw new Error("API not initialized");
        if (type === 1) {
            try {
                return await this.api.getGroupChatHistory(threadId, count ?? 500);
            }
            catch (error) {
                // zca-js có thể throw SyntaxError khi response JSON bị truncated
                if (error instanceof SyntaxError) {
                    throw new Error(`Không thể tải tin nhắn nhóm (lỗi phản hồi từ Zalo): ${error.message}`);
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
    async setPinConversations(conversations, isPin) {
        if (!this.api)
            throw new Error("API not initialized");
        let threadIds;
        let threadType = 0; // ThreadType.User default
        if (Array.isArray(conversations) && conversations.length > 0 && typeof conversations[0] === 'object' && conversations[0] !== null) {
            const convObjs = conversations;
            threadIds = convObjs.map(c => String(c.threadId));
            threadType = convObjs[0].type ?? 0;
        }
        else if (Array.isArray(conversations)) {
            threadIds = conversations.map(String);
        }
        else {
            threadIds = [String(conversations)];
        }
        return await this.api.setPinnedConversations(isPin, threadIds, threadType);
    }
    async getGroupChatHistory(groupId, count = 500) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.getGroupChatHistory(groupId, count);
        }
        catch (error) {
            if (error instanceof SyntaxError) {
                throw new Error(`Không thể tải tin nhắn nhóm (lỗi phản hồi từ Zalo): ${error.message}`);
            }
            throw error;
        }
    }
    async updateArchivedChatList(isArchived, conversationsData) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        let dataUpdate = [], conversationArray = JSON.parse(conversationsData);
        conversationArray.forEach((item) => {
            dataUpdate.push({
                id: item.id,
                type: item.thread == 1 ? zca_js_1.ThreadType.Group : zca_js_1.ThreadType.User,
            });
        });
        try {
            return await this.api.updateArchivedChatList(isArchived == 1, dataUpdate);
        }
        catch (error) {
            throw error;
        }
    }
    async sendBankCard(payload, threadId, type = zca_js_1.ThreadType.User) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        const parsedPayload = typeof payload == 'string' ? JSON.parse(payload) : payload, binBank = parsedPayload.binBank || '', numAccBank = parsedPayload.numAccBank || '', nameAccBank = parsedPayload.nameAccBank || '';
        if (!binBank || !numAccBank) {
            throw new Error("Invalid payload: empty array");
        }
        const finalPayload = {
            binBank: parseInt(binBank),
            numAccBank,
            nameAccBank,
        };
        try {
            return await this.api.sendBankCard(finalPayload, threadId, type);
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Gửi sự kiện đã đọc tin nhắn (seen event) cho Zalo
     */
    async sendSeenEvent(messages, type = zca_js_1.ThreadType.User) {
        if (!this.api) {
            throw new Error("API not initialized. Please ensure you've called initialize() first.");
        }
        try {
            return await this.api.sendSeenEvent(messages, type);
        }
        catch (error) {
            throw error;
        }
    }
    async addGroupDeputy(userId, groupId) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.addGroupDeputy(userId, groupId);
        }
        catch (error) {
            throw error;
        }
    }
    async removeGroupDeputy(userId, groupId) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.removeGroupDeputy(userId, groupId);
        }
        catch (error) {
            throw error;
        }
    }
    async changeGroupOwner(userId, groupId) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.changeGroupOwner(userId, groupId);
        }
        catch (error) {
            throw error;
        }
    }
    async getGroupMembersInfo(groupId, memberIds) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            const ids = memberIds && memberIds.length > 0 ? memberIds : [groupId];
            return await this.api.getGroupMembersInfo(ids);
        }
        catch (error) {
            throw error;
        }
    }
    async addGroupBlockedMember(userId, groupId) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.addGroupBlockedMember(userId, groupId);
        }
        catch (error) {
            throw error;
        }
    }
    async removeGroupBlockedMember(userId, groupId) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.removeGroupBlockedMember(userId, groupId);
        }
        catch (error) {
            throw error;
        }
    }
    async getGroupBlockedMember(groupId) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.getGroupBlockedMember(groupId);
        }
        catch (error) {
            throw error;
        }
    }
    async inviteUserToGroups(userId, groupIds) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.inviteUserToGroups(userId, groupIds);
        }
        catch (error) {
            throw error;
        }
    }
    async addUnreadMark(threadId, type) {
        if (!this.api)
            throw new Error("API not initialized");
        const t = (0, Utils_1.convertThreadType)(type);
        try {
            return await this.api.addUnreadMark(threadId, t);
        }
        catch (error) {
            throw error;
        }
    }
    async removeUnreadMark(threadId, type) {
        if (!this.api)
            throw new Error("API not initialized");
        const t = (0, Utils_1.convertThreadType)(type);
        try {
            return await this.api.removeUnreadMark(threadId, t);
        }
        catch (error) {
            throw error;
        }
    }
    async createPoll(options, groupId) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.createPoll(options, groupId);
        }
        catch (error) {
            throw error;
        }
    }
    async getPollDetail(pollId) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.getPollDetail(pollId);
        }
        catch (error) {
            throw error;
        }
    }
    async lockPoll(pollId) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.lockPoll(pollId);
        }
        catch (error) {
            throw error;
        }
    }
    async doVotePoll(pollId, optionIds) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.votePoll(pollId, optionIds);
        }
        catch (error) {
            throw error;
        }
    }
    async addPollOption(pollId, option) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.addPollOptions({
                pollId,
                options: [{ voted: false, content: option }],
                votedOptionIds: [],
            });
        }
        catch (error) {
            throw error;
        }
    }
    // ─── Tin nhắn nhanh ──────────────────────────────────────────────────────
    async getQuickMessageList() {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.getQuickMessageList();
        }
        catch (error) {
            throw error;
        }
    }
    async addQuickMessage(payload) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            const addPayload = { keyword: payload.keyword, title: payload.title };
            if (payload.mediaPath)
                addPayload.media = payload.mediaPath;
            return await this.api.addQuickMessage(addPayload);
        }
        catch (error) {
            throw error;
        }
    }
    async updateQuickMessage(payload, itemId) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            const updatePayload = { keyword: payload.keyword, title: payload.title };
            if (payload.mediaPath)
                updatePayload.media = payload.mediaPath;
            return await this.api.updateQuickMessage(updatePayload, itemId);
        }
        catch (error) {
            throw error;
        }
    }
    async removeQuickMessage(itemIds) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.removeQuickMessage(itemIds);
        }
        catch (error) {
            throw error;
        }
    }
    // ─── Ghi chú nhóm ────────────────────────────────────────────────────────
    async createNote(options, groupId) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.createNote(options, groupId);
        }
        catch (error) {
            throw error;
        }
    }
    async editNote(options, groupId) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.editNote(options, groupId);
        }
        catch (error) {
            throw error;
        }
    }
    // ─── Phê duyệt thành viên nhóm ───────────────────────────────────────────
    async reviewPendingMemberRequest(payload, groupId) {
        if (!this.api)
            throw new Error("API not initialized");
        try {
            return await this.api.reviewPendingMemberRequest(payload, groupId);
        }
        catch (error) {
            throw error;
        }
    }
}
ZaloService.instances = new Map();
exports.default = ZaloService;
//# sourceMappingURL=ZaloService.js.map