"use strict";
/**
 * AIAssistantService.ts
 *
 * Main-process singleton service for AI Assistants.
 * Manages CRUD, API calls to LLM providers, chat suggestions, and direct chat.
 * Reuses the same OpenAI/Gemini/Deepseek/Grok patterns from WorkflowEngineService.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const electron_1 = require("electron");
const uuid_1 = require("uuid");
const DatabaseService_1 = __importDefault(require("./DatabaseService"));
const IntegrationRegistry_1 = __importDefault(require("./integrations/IntegrationRegistry"));
const Logger_1 = __importDefault(require("../utils/Logger"));
// ─── Encryption helpers ───────────────────────────────────────────────────────
function encryptApiKey(key) {
    if (!key)
        return '';
    try {
        if (electron_1.safeStorage.isEncryptionAvailable()) {
            return 'enc:' + electron_1.safeStorage.encryptString(key).toString('base64');
        }
    }
    catch { }
    return key;
}
function decryptApiKey(raw) {
    if (!raw)
        return '';
    if (raw.startsWith('enc:')) {
        try {
            const buf = Buffer.from(raw.slice(4), 'base64');
            return electron_1.safeStorage.decryptString(buf);
        }
        catch { }
    }
    return raw;
}
// ─── Platform URL helpers ─────────────────────────────────────────────────────
function getOpenAICompatibleUrl(platform) {
    switch (platform) {
        case 'deepseek': return 'https://api.deepseek.com/v1/chat/completions';
        case 'grok': return 'https://api.x.ai/v1/chat/completions';
        case 'mistral': return 'https://api.mistral.ai/v1/chat/completions';
        case 'openai':
        default: return 'https://api.openai.com/v1/chat/completions';
    }
}
function openaiMessagesToGemini(messages) {
    const contents = [];
    let systemText = '';
    for (const msg of messages) {
        if (msg.role === 'system') {
            systemText += (systemText ? '\n' : '') + msg.content;
            continue;
        }
        const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
        contents.push({ role: geminiRole, parts: [{ text: msg.content }] });
    }
    if (systemText) {
        contents.unshift({ role: 'user', parts: [{ text: `System instruction: ${systemText}` }] }, { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] });
    }
    return contents;
}
// ─── Service ──────────────────────────────────────────────────────────────────
class AIAssistantService {
    static getInstance() {
        if (!AIAssistantService.instance)
            AIAssistantService.instance = new AIAssistantService();
        return AIAssistantService.instance;
    }
    constructor() { }
    // ─── CRUD ────────────────────────────────────────────────────────────────
    listAssistants() {
        const db = DatabaseService_1.default.getInstance();
        const rows = db.query(`SELECT * FROM ai_assistants ORDER BY is_default DESC, updated_at DESC`);
        return rows.map(this.rowToAssistant);
    }
    getAssistant(id) {
        const db = DatabaseService_1.default.getInstance();
        const rows = db.query(`SELECT * FROM ai_assistants WHERE id = ?`, [id]);
        if (!rows.length)
            return null;
        const assistant = this.rowToAssistant(rows[0]);
        Logger_1.default.info(`[AIAssistant] getAssistant id=${id}, pinnedProductsJson.length=${assistant.pinnedProductsJson?.length || 0}, posIntegrationId=${assistant.posIntegrationId}`);
        return assistant;
    }
    getDefaultAssistant() {
        const db = DatabaseService_1.default.getInstance();
        const rows = db.query(`SELECT * FROM ai_assistants WHERE is_default = 1 AND enabled = 1 LIMIT 1`);
        if (rows.length)
            return this.rowToAssistant(rows[0]);
        // Fallback: first enabled assistant
        const fallback = db.query(`SELECT * FROM ai_assistants WHERE enabled = 1 ORDER BY updated_at DESC LIMIT 1`);
        return fallback.length ? this.rowToAssistant(fallback[0]) : null;
    }
    saveAssistant(data) {
        const db = DatabaseService_1.default.getInstance();
        const id = data.id || (0, uuid_1.v4)();
        const now = Date.now();
        // If apiKey is the masked placeholder '***', pass it through as-is
        // so the SQL CASE can detect it and preserve the existing key.
        const encrypted = data.apiKey === '***' ? '***' : encryptApiKey(data.apiKey);
        const pinnedJson = data.pinnedProductsJson || '[]';
        Logger_1.default.info(`[AIAssistant] saveAssistant id=${id}, posIntegrationId=${data.posIntegrationId || 'null'}, pinnedProductsJson.length=${pinnedJson.length}, pinnedPreview=${pinnedJson.substring(0, 200)}`);
        // If setting as default, unset others
        if (data.isDefault) {
            db.run(`UPDATE ai_assistants SET is_default = 0`);
        }
        db.run(`INSERT INTO ai_assistants (id, name, platform, api_key_encrypted, model, system_prompt, pos_integration_id, pinned_products_json, max_tokens, temperature, context_message_count, enabled, is_default, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name, platform = excluded.platform,
              api_key_encrypted = CASE WHEN excluded.api_key_encrypted = '***' THEN ai_assistants.api_key_encrypted ELSE excluded.api_key_encrypted END,
              model = excluded.model, system_prompt = excluded.system_prompt,
              pos_integration_id = excluded.pos_integration_id,
              pinned_products_json = excluded.pinned_products_json,
              max_tokens = excluded.max_tokens, temperature = excluded.temperature,
              context_message_count = excluded.context_message_count,
              enabled = excluded.enabled, is_default = excluded.is_default,
              updated_at = excluded.updated_at`, [
            id, data.name, data.platform, encrypted, data.model,
            data.systemPrompt || '', data.posIntegrationId || null,
            pinnedJson,
            data.maxTokens || 1000, data.temperature ?? 0.7,
            data.contextMessageCount || 30,
            data.enabled !== false ? 1 : 0, data.isDefault ? 1 : 0,
            data.id ? now : now, now,
        ]);
        // Verify save: read back and check pinned_products_json
        try {
            const verify = db.query(`SELECT pinned_products_json FROM ai_assistants WHERE id = ?`, [id]);
            const saved = verify[0]?.pinned_products_json || '[]';
            Logger_1.default.info(`[AIAssistant] saveAssistant VERIFY: id=${id}, savedPinnedLen=${saved.length}, match=${saved === pinnedJson}`);
        }
        catch (e) {
            Logger_1.default.warn(`[AIAssistant] saveAssistant VERIFY failed: ${e.message}`);
        }
        return id;
    }
    deleteAssistant(id) {
        const db = DatabaseService_1.default.getInstance();
        db.run(`DELETE FROM ai_assistant_files WHERE assistant_id = ?`, [id]);
        db.run(`DELETE FROM ai_assistants WHERE id = ?`, [id]);
    }
    // ─── Files ──────────────────────────────────────────────────────────────
    getFiles(assistantId) {
        const db = DatabaseService_1.default.getInstance();
        const rows = db.query(`SELECT * FROM ai_assistant_files WHERE assistant_id = ? ORDER BY created_at DESC`, [assistantId]);
        return rows.map((r) => ({
            id: r.id,
            assistantId: r.assistant_id,
            fileName: r.file_name,
            filePath: r.file_path,
            fileSize: r.file_size,
            contentText: r.content_text || '',
            createdAt: r.created_at,
        }));
    }
    addFile(assistantId, fileName, filePath, fileSize, contentText) {
        const db = DatabaseService_1.default.getInstance();
        db.run(`INSERT INTO ai_assistant_files (assistant_id, file_name, file_path, file_size, content_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`, [assistantId, fileName, filePath, fileSize, contentText, Date.now()]);
        const rows = db.query(`SELECT last_insert_rowid() as id`);
        return rows[0]?.id || 0;
    }
    removeFile(fileId) {
        DatabaseService_1.default.getInstance().run(`DELETE FROM ai_assistant_files WHERE id = ?`, [fileId]);
    }
    // ─── AI API Calls ────────────────────────────────────────────────────────
    /**
     * Build full system prompt with knowledge base + POS products
     * @param forWorkflow - If true, append structured JSON output instructions for workflow auto-reply
     */
    async buildSystemPrompt(assistant, forWorkflow = false) {
        const parts = [];
        // 1. Custom system prompt
        if (assistant.systemPrompt)
            parts.push(assistant.systemPrompt);
        // 2. Knowledge base files
        const files = this.getFiles(assistant.id);
        if (files.length > 0) {
            const kbText = files
                .filter(f => f.contentText.trim())
                .map(f => `--- ${f.fileName} ---\n${f.contentText}`)
                .join('\n\n');
            if (kbText) {
                parts.push(`\n\n[Kiến thức tham khảo]\n${kbText}`);
            }
        }
        // 3. POS product data — prefer pinned products, fallback to live fetch
        let pinnedProducts = [];
        try {
            pinnedProducts = JSON.parse(assistant.pinnedProductsJson || '[]');
        }
        catch { }
        Logger_1.default.info(`[AIAssistant] buildSystemPrompt: pinnedProducts=${pinnedProducts.length}, posIntegrationId=${assistant.posIntegrationId}, forWorkflow=${forWorkflow}`);
        if (pinnedProducts.length > 0) {
            // Use user-curated pinned products
            const productList = pinnedProducts.map((p) => {
                const name = p.name || p._name || '';
                const price = p.price || p._price || 'N/A';
                const sku = p.code || p._code || 'N/A';
                const imgUrl = p.image || p._image || '';
                return `- ${name} | Giá: ${price} | SKU: ${sku}${imgUrl ? ` | Ảnh: ${imgUrl}` : ''}`;
            }).join('\n');
            parts.push(`\n\n[Danh sách sản phẩm (${pinnedProducts.length} SP đã chọn)]\n${productList}`);
        }
        else if (assistant.posIntegrationId) {
            // Fallback: live fetch from POS (legacy behavior)
            try {
                const result = await IntegrationRegistry_1.default.executeAction(assistant.posIntegrationId, 'lookupProduct', { keyword: '', limit: 50 });
                if (result && Array.isArray(result.products) && result.products.length > 0) {
                    const productList = result.products.slice(0, 50).map((p) => {
                        const name = p.name || p.productName || '';
                        const price = p.price || p.basePrice || 'N/A';
                        const sku = p.code || p.sku || 'N/A';
                        const imgUrl = p.imageUrl || p.image?.src || p.images?.[0]?.src || p.images?.[0]?.url
                            || p.image_url || p.image || p.smallImage || p.thumbnail || '';
                        return `- ${name} | Giá: ${price} | SKU: ${sku}${imgUrl ? ` | Ảnh: ${imgUrl}` : ''}`;
                    }).join('\n');
                    parts.push(`\n\n[Danh sách sản phẩm]\n${productList}`);
                }
            }
            catch (e) {
                Logger_1.default.warn(`[AIAssistant] Failed to load POS products: ${e.message}`);
            }
        }
        // 4. Workflow auto-reply: structured JSON output + natural conversational tone
        if (forWorkflow) {
            parts.push(`

[QUY TẮC TRẢ LỜI — BẮT BUỘC TUÂN THỦ 100%]

1. PHONG CÁCH: Trả lời tự nhiên như người thật đang chat. Ngắn gọn, thân thiện, KHÔNG dùng markdown, KHÔNG dùng bullet/numbering, KHÔNG dùng emoji quá nhiều.

2. CHIA CÂU: Mỗi ý tách riêng thành 1 câu ngắn gọn (mỗi câu là 1 tin nhắn chat riêng). KHÔNG dồn hết mọi thứ vào 1 đoạn dài. Tưởng tượng bạn đang nhắn tin trên điện thoại — mỗi lần gửi 1-2 câu ngắn.

3. HÌNH ẢNH: Nếu trong dữ liệu kiến thức/sản phẩm có link ảnh (URL bắt đầu bằng http:// hoặc https:// và kết thúc bằng .jpg, .jpeg, .png, .gif, .webp hoặc chứa /image), hãy trả về dạng image. Chỉ gửi ảnh khi thực sự liên quan đến câu hỏi.

4. ĐỊNH DẠNG ĐẦU RA: BẮT BUỘC trả về JSON array, KHÔNG trả về text thuần. Mỗi phần tử có dạng:
   - Tin nhắn text: {"type": "text", "content": "Nội dung tin nhắn"}
   - Hình ảnh: {"type": "image", "content": ["url_ảnh_1", "url_ảnh_2"]}

VÍ DỤ ĐẦU RA ĐÚNG:
[
  {"type": "text", "content": "Chào bạn!"},
  {"type": "text", "content": "Sản phẩm A giá 240.000đ nha"},
  {"type": "image", "content": ["https://example.com/product-a.jpg"]},
  {"type": "text", "content": "Bạn cần tư vấn thêm gì không?"}
]

5. KHÔNG BAO GIỜ trả về text thường. LUÔN LUÔN trả về JSON array như trên.`);
        }
        return parts.join('\n');
    }
    /**
     * Call LLM API with messages
     */
    async callLLM(assistant, messages, maxTokensOverride) {
        const maxTokens = maxTokensOverride || assistant.maxTokens || 1000;
        const temperature = assistant.temperature ?? 0.7;
        // Debug: log request info
        const keyPreview = assistant.apiKey ? `${assistant.apiKey.substring(0, 8)}...${assistant.apiKey.substring(assistant.apiKey.length - 4)}` : '(empty)';
        Logger_1.default.info(`[AIAssistant] callLLM → platform=${assistant.platform}, model=${assistant.model}, keyPreview=${keyPreview}, maxTokens=${maxTokens}`);
        let result = '';
        let promptTokens = 0;
        let completionTokens = 0;
        let totalTokens = 0;
        try {
            if (assistant.platform === 'gemini') {
                const geminiContents = openaiMessagesToGemini(messages);
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${assistant.model}:generateContent?key=${keyPreview}`;
                Logger_1.default.info(`[AIAssistant] Gemini URL (masked): ${geminiUrl}`);
                const res = await axios_1.default.post(`https://generativelanguage.googleapis.com/v1beta/models/${assistant.model}:generateContent?key=${assistant.apiKey}`, {
                    contents: geminiContents,
                    generationConfig: { maxOutputTokens: maxTokens, temperature },
                }, { headers: { 'Content-Type': 'application/json' }, timeout: 60000 });
                result = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
                promptTokens = res.data.usageMetadata?.promptTokenCount || 0;
                completionTokens = res.data.usageMetadata?.candidatesTokenCount || 0;
                totalTokens = promptTokens + completionTokens;
            }
            else if (assistant.platform === 'claude') {
                // Anthropic Claude Messages API
                Logger_1.default.info(`[AIAssistant] Claude URL: https://api.anthropic.com/v1/messages`);
                const systemText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
                const claudeMessages = messages
                    .filter(m => m.role !== 'system')
                    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
                const res = await axios_1.default.post('https://api.anthropic.com/v1/messages', {
                    model: assistant.model,
                    max_tokens: maxTokens,
                    ...(systemText ? { system: systemText } : {}),
                    messages: claudeMessages,
                }, {
                    headers: {
                        'x-api-key': assistant.apiKey,
                        'anthropic-version': '2023-06-01',
                        'Content-Type': 'application/json',
                    },
                    timeout: 60000,
                });
                result = res.data.content?.[0]?.text?.trim() || '';
                promptTokens = res.data.usage?.input_tokens || 0;
                completionTokens = res.data.usage?.output_tokens || 0;
                totalTokens = promptTokens + completionTokens;
            }
            else {
                const apiUrl = getOpenAICompatibleUrl(assistant.platform);
                Logger_1.default.info(`[AIAssistant] OpenAI-compat URL: ${apiUrl}, model: ${assistant.model}`);
                const tokenParam = assistant.platform === 'openai'
                    ? { max_completion_tokens: maxTokens }
                    : { max_tokens: maxTokens };
                const res = await axios_1.default.post(apiUrl, { model: assistant.model, messages, ...tokenParam, temperature }, {
                    headers: {
                        Authorization: `Bearer ${assistant.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 60000,
                });
                result = res.data.choices?.[0]?.message?.content?.trim() || '';
                promptTokens = res.data.usage?.prompt_tokens || 0;
                completionTokens = res.data.usage?.completion_tokens || 0;
                totalTokens = res.data.usage?.total_tokens || (promptTokens + completionTokens);
            }
        }
        catch (err) {
            // Enhanced error logging
            const status = err.response?.status;
            const errData = err.response?.data;
            const errMsg = errData?.error?.message || errData?.error || errData?.message || err.message;
            Logger_1.default.error(`[AIAssistant] callLLM FAILED → status=${status}, platform=${assistant.platform}, model=${assistant.model}, error=${JSON.stringify(errMsg)}, fullResponse=${JSON.stringify(errData)?.substring(0, 1000)}`);
            throw err;
        }
        // Log usage to DB
        try {
            this.logUsage(assistant.id, assistant.name, assistant.platform, assistant.model, messages.map(m => m.content).join('\n---\n').substring(0, 5000), result.substring(0, 5000), promptTokens, completionTokens, totalTokens);
        }
        catch { }
        return { result, totalTokens, promptTokens, completionTokens };
    }
    // ─── Public AI methods ──────────────────────────────────────────────────
    /**
     * Generate chat suggestions based on recent chat history
     */
    async getSuggestions(assistantId, chatHistory) {
        const assistant = this.getAssistant(assistantId);
        if (!assistant || !assistant.enabled)
            return [];
        const contextCount = assistant.contextMessageCount || 30;
        const systemPrompt = await this.buildSystemPrompt(assistant);
        const messages = [
            {
                role: 'system',
                content: `${systemPrompt}\n\n[Hướng dẫn] Dựa trên lịch sử hội thoại bên dưới, hãy gợi ý đúng 5 câu trả lời ngắn gọn, tự nhiên và phù hợp nhất cho người bán/hỗ trợ viên.\nBẮT BUỘC trả về đúng định dạng JSON array gồm 5 phần tử string, KHÔNG thêm bất kỳ text nào khác.\nVí dụ: ["Câu 1","Câu 2","Câu 3","Câu 4","Câu 5"]`
            },
            ...chatHistory.slice(-contextCount).map(m => ({
                role: m.role,
                content: m.content,
            })),
        ];
        try {
            const { result } = await this.callLLM(assistant, messages, 500);
            Logger_1.default.info(`[AIAssistant] getSuggestions raw result: ${result}`);
            // Try parsing as JSON array first (preferred format)
            let suggestions = [];
            try {
                // Extract JSON array from response (may have surrounding text)
                const jsonMatch = result.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (Array.isArray(parsed)) {
                        suggestions = parsed.map((s) => String(s).trim()).filter(s => s.length > 0);
                    }
                }
            }
            catch {
                // Fallback: split by newlines and clean up numbering/bullets
                Logger_1.default.info(`[AIAssistant] getSuggestions JSON parse failed, falling back to line split`);
                suggestions = result
                    .split('\n')
                    .map(s => s.trim())
                    .map(s => s.replace(/^[\d]+[.):\-]\s*/, '')) // remove numbering like "1. ", "1) ", "1- "
                    .map(s => s.replace(/^[-•*]\s*/, '')) // remove bullets like "- ", "• ", "* "
                    .map(s => s.replace(/^["']|["']$/g, '')) // remove surrounding quotes
                    .map(s => s.trim())
                    .filter(s => s.length > 0);
            }
            Logger_1.default.info(`[AIAssistant] getSuggestions parsed ${suggestions.length} suggestions: ${JSON.stringify(suggestions)}`);
            return suggestions.slice(0, 5);
        }
        catch (e) {
            Logger_1.default.error(`[AIAssistant] getSuggestions error: ${e.message}`);
            return [];
        }
    }
    /**
     * Direct chat with AI assistant
     * @param structured - If true, use structured JSON output rules (text/image segments) same as workflow
     */
    async chat(assistantId, conversationMessages, structured = false) {
        const assistant = this.getAssistant(assistantId);
        if (!assistant)
            throw new Error('Trợ lý AI không tồn tại');
        if (!assistant.enabled)
            throw new Error('Trợ lý AI đã bị tắt');
        const systemPrompt = await this.buildSystemPrompt(assistant, structured);
        const messages = [
            { role: 'system', content: systemPrompt },
            ...conversationMessages.map(m => ({
                role: m.role,
                content: m.content,
            })),
        ];
        return await this.callLLM(assistant, messages);
    }
    /**
     * Chat with AI assistant for workflow auto-reply.
     * Uses structured JSON output format (text/image segments) + natural conversational tone.
     */
    async chatForWorkflow(assistantId, conversationMessages) {
        const assistant = this.getAssistant(assistantId);
        if (!assistant)
            throw new Error('Trợ lý AI không tồn tại');
        if (!assistant.enabled)
            throw new Error('Trợ lý AI đã bị tắt');
        const systemPrompt = await this.buildSystemPrompt(assistant, true);
        const messages = [
            { role: 'system', content: systemPrompt },
            ...conversationMessages.map(m => ({
                role: m.role,
                content: m.content,
            })),
        ];
        return await this.callLLM(assistant, messages);
    }
    /**
     * Test API key / connection
     */
    async testConnection(assistantId) {
        const assistant = this.getAssistant(assistantId);
        if (!assistant)
            return { success: false, message: 'Không tìm thấy trợ lý' };
        try {
            const { result } = await this.callLLM(assistant, [
                { role: 'user', content: 'Xin chào, đây là tin nhắn test. Trả lời ngắn gọn.' }
            ], 50);
            return { success: true, message: result ? `✅ Kết nối thành công! AI trả lời: "${result.substring(0, 80)}"` : '✅ Kết nối OK' };
        }
        catch (e) {
            return { success: false, message: `❌ Lỗi: ${e.response?.data?.error?.message || e.message}` };
        }
    }
    // ─── Usage logging & reporting ─────────────────────────────────────────
    logUsage(assistantId, assistantName, platform, model, promptText, responseText, promptTokens, completionTokens, totalTokens) {
        const db = DatabaseService_1.default.getInstance();
        db.run(`INSERT INTO ai_usage_logs (assistant_id, assistant_name, platform, model, prompt_text, response_text, prompt_tokens, completion_tokens, total_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [assistantId, assistantName, platform, model, promptText, responseText, promptTokens, completionTokens, totalTokens, Date.now()]);
    }
    /**
     * Get usage logs with optional filters
     */
    getUsageLogs(opts) {
        const db = DatabaseService_1.default.getInstance();
        let sql = 'SELECT * FROM ai_usage_logs WHERE 1=1';
        const params = [];
        if (opts?.assistantId) {
            sql += ' AND assistant_id = ?';
            params.push(opts.assistantId);
        }
        if (opts?.dateFrom) {
            sql += ' AND created_at >= ?';
            params.push(opts.dateFrom);
        }
        if (opts?.dateTo) {
            sql += ' AND created_at <= ?';
            params.push(opts.dateTo);
        }
        sql += ' ORDER BY created_at DESC';
        if (opts?.limit) {
            sql += ' LIMIT ?';
            params.push(opts.limit);
        }
        return db.query(sql, params);
    }
    /**
     * Get aggregated usage stats grouped by day
     */
    getUsageStats(opts) {
        const db = DatabaseService_1.default.getInstance();
        const daysBack = opts?.days || 30;
        const since = Date.now() - daysBack * 86400000;
        let sql = `
      SELECT
        date(created_at / 1000, 'unixepoch', 'localtime') as day,
        assistant_name,
        assistant_id,
        platform,
        model,
        COUNT(*) as request_count,
        SUM(prompt_tokens) as total_prompt_tokens,
        SUM(completion_tokens) as total_completion_tokens,
        SUM(total_tokens) as total_tokens
      FROM ai_usage_logs
      WHERE created_at >= ?
    `;
        const params = [since];
        if (opts?.assistantId) {
            sql += ' AND assistant_id = ?';
            params.push(opts.assistantId);
        }
        sql += ' GROUP BY day, assistant_id ORDER BY day DESC, request_count DESC';
        return db.query(sql, params);
    }
    // ─── Per-account assistant assignment ─────────────────────────────────
    /**
     * Get assistant assigned for a specific account+role, falling back to global default
     */
    getAssistantForAccount(zaloId, role) {
        const db = DatabaseService_1.default.getInstance();
        const rows = db.query(`SELECT assistant_id FROM ai_account_assistants WHERE zalo_id = ? AND role = ?`, [zaloId, role]);
        if (rows.length > 0) {
            const assistant = this.getAssistant(rows[0].assistant_id);
            if (assistant && assistant.enabled)
                return assistant;
        }
        // Fallback to global default
        return this.getDefaultAssistant();
    }
    /**
     * Set assistant for a specific account+role
     */
    setAccountAssistant(zaloId, role, assistantId) {
        const db = DatabaseService_1.default.getInstance();
        if (!assistantId) {
            db.run(`DELETE FROM ai_account_assistants WHERE zalo_id = ? AND role = ?`, [zaloId, role]);
        }
        else {
            db.run(`INSERT INTO ai_account_assistants (zalo_id, role, assistant_id) VALUES (?, ?, ?)
              ON CONFLICT(zalo_id, role) DO UPDATE SET assistant_id = excluded.assistant_id`, [zaloId, role, assistantId]);
        }
    }
    /**
     * Get all account assistant assignments
     */
    getAccountAssistants(zaloId) {
        const db = DatabaseService_1.default.getInstance();
        const rows = db.query(`SELECT role, assistant_id FROM ai_account_assistants WHERE zalo_id = ?`, [zaloId]);
        const result = { suggestion: null, panel: null };
        for (const row of rows) {
            if (row.role === 'suggestion')
                result.suggestion = row.assistant_id;
            if (row.role === 'panel')
                result.panel = row.assistant_id;
        }
        return result;
    }
    // ─── Row mapper ─────────────────────────────────────────────────────────
    rowToAssistant(row) {
        return {
            id: row.id,
            name: row.name,
            platform: row.platform,
            apiKey: decryptApiKey(row.api_key_encrypted),
            model: row.model,
            systemPrompt: row.system_prompt || '',
            posIntegrationId: row.pos_integration_id || null,
            pinnedProductsJson: row.pinned_products_json || '[]',
            maxTokens: row.max_tokens || 1000,
            temperature: row.temperature ?? 0.7,
            contextMessageCount: row.context_message_count || 30,
            enabled: row.enabled === 1,
            isDefault: row.is_default === 1,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
}
exports.default = AIAssistantService;
//# sourceMappingURL=AIAssistantService.js.map