import { ipcMain } from 'electron';
import DatabaseService from '../../src/services/database/DatabaseService';
import CRMQueueService from '../../src/services/crm/CRMQueueService';
import EventBroadcaster from '../../src/services/event/EventBroadcaster';
import WorkspaceManager from '../../src/utils/WorkspaceManager';
import Logger from '../../src/utils/Logger';
import { proxyToBossWithResult, uploadEmployeeMedia } from './proxyHelper';
import { getCRMChannelDecision, validateCampaignForChannel } from '../../src/services/crm/CRMChannelCapabilityService';

function isEmployeeMode(): boolean {
    try {
        const activeWs = WorkspaceManager.getInstance().getActiveWorkspace();
        if (activeWs?.type === 'remote') return true;
    } catch {}
    return false;
}

/**
 * Nhân viên lưu chiến dịch: ảnh trong mẫu tin (template_message.blocks[].images) là đường dẫn trên máy nhân viên →
 * upload lên Boss, thay bằng đường dẫn Boss (hàng đợi gửi chạy trên Boss). Đường dẫn không có trên máy này (đã là
 * file Boss khi sửa chiến dịch cũ) giữ nguyên. Upload lỗi → báo lỗi, không lưu chiến dịch với ảnh Boss không đọc được.
 */
async function uploadCampaignImagesToBoss(campaign: any, zaloId: string): Promise<{ success: true; campaign: any } | { success: false; error: string }> {
    if (!campaign?.template_message) return { success: true, campaign };
    let parsed: any;
    try {
        parsed = typeof campaign.template_message === 'string' ? JSON.parse(campaign.template_message) : campaign.template_message;
    } catch {
        return { success: true, campaign }; // mẫu tin dạng chữ thường, không có ảnh
    }
    if (!parsed?.blocks || !Array.isArray(parsed.blocks)) return { success: true, campaign };
    let changed = false;
    try {
        for (const block of parsed.blocks) {
            if (Array.isArray(block?.images) && block.images.length > 0) {
                block.images = await uploadEmployeeMedia(block.images, zaloId);
                changed = true;
            }
        }
    } catch (err: any) {
        Logger.warn(`[crmIpc] Upload campaign images failed: ${err.message}`);
        return { success: false, error: `Không tải được ảnh chiến dịch lên Boss: ${err.message}` };
    }
    if (!changed) return { success: true, campaign };
    return {
        success: true,
        campaign: { ...campaign, template_message: typeof campaign.template_message === 'string' ? JSON.stringify(parsed) : parsed },
    };
}

export function registerCRMIpc(): void {


    // ─── Notes ─────────────────────────────────────────────────────────────
    ipcMain.handle('crm:getNotes', async (_e, { zaloId, contactId }: { zaloId: string; contactId: string }) => {
        try {
            if (isEmployeeMode()) return { success: true, notes: [] };
            return { success: true, notes: DatabaseService.getInstance().getCRMNotes(zaloId, contactId) };
        }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    // Nhân viên: ghi chú nằm trên DB Boss → proxy chờ kết quả (id do Boss cấp, lỗi hiện lên UI), không ghi bản sao cục
    // bộ (id cục bộ ≠ id Boss; bản sao cục bộ cập nhật qua event crm:noteChanged). Trước đây proxy HAI lần (đầu + cuối
    // handler) → mỗi lần thêm, Boss tạo 2 ghi chú giống nhau và phát event 2 lần.
    ipcMain.handle('crm:saveNote', async (_e, { zaloId, note }: { zaloId: string; note: any }) => {
        try {
            if (isEmployeeMode()) return await proxyToBossWithResult('crm:saveNote', { zaloId, note });
            const id = DatabaseService.getInstance().saveCRMNote({ ...note, owner_zalo_id: zaloId });
            if (!id) return { success: false, error: 'Không lưu được ghi chú' };
            DatabaseService.getInstance().save();
            // note kèm id: máy nhân viên lưu bản sao theo id (sửa ghi chú không thành ghi chú mới)
            EventBroadcaster.emit('crm:noteChanged', { action: 'save', ownerZaloId: zaloId, id, note: { ...note, id } });
            return { success: true, id };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:deleteNote', async (_e, { zaloId, noteId }: { zaloId: string; noteId: number }) => {
        try {
            if (isEmployeeMode()) return await proxyToBossWithResult('crm:deleteNote', { zaloId, noteId });
            DatabaseService.getInstance().deleteCRMNote(noteId, zaloId);
            DatabaseService.getInstance().save();
            EventBroadcaster.emit('crm:noteChanged', { action: 'delete', ownerZaloId: zaloId, noteId });
            return { success: true };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    // ─── Contacts ──────────────────────────────────────────────────────────
    ipcMain.handle('crm:getContacts', async (_e, { zaloId, opts }: { zaloId: string; opts?: any }) => {
        try {
            if (isEmployeeMode()) return { success: true, contacts: [], total: 0 };
            return { success: true, ...DatabaseService.getInstance().getCRMContacts(zaloId, opts || {}) };
        }
        catch (e: any) { return { success: false, error: e.message, contacts: [], total: 0 }; }
    });

    ipcMain.handle('crm:getContactStats', async (_e, { zaloId }: { zaloId: string }) => {
        try {
            if (isEmployeeMode()) return { success: true, total: 0, friendCount: 0, noteCount: 0 };
            return { success: true, ...DatabaseService.getInstance().getContactStats(zaloId) };
        }
        catch (e: any) { return { success: false, error: e.message, total: 0, friendCount: 0, noteCount: 0 }; }
    });

    // ─── Campaigns ─────────────────────────────────────────────────────────
    ipcMain.handle('crm:getCampaigns', async (_e, { zaloId }: { zaloId: string }) => {
        try {
            if (isEmployeeMode()) return { success: true, campaigns: [] };
            const capability = getCRMChannelDecision(zaloId, 'campaign');
            if (!capability.allowed) return { success: true, campaigns: [] };
            return { success: true, campaigns: DatabaseService.getInstance().getCRMCampaigns(zaloId) };
        }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    // Chiến dịch chạy trên Boss (hàng đợi CRM). Nhân viên: proxy chờ kết quả, KHÔNG kiểm tra / ghi trên DB cục bộ
    // (DB cục bộ không có chiến dịch của Boss → trước đây clone / đổi trạng thái / thêm liên hệ dừng ở "Không tìm thấy
    // chiến dịch" mà không bao giờ gửi lên Boss; lưu thì tạo bản sao cục bộ id khác Boss). Boss kiểm tra chủ chiến dịch
    // (HttpRelayService.checkProxyRecordOwner) rồi chạy chính các handler này.
    ipcMain.handle('crm:saveCampaign', async (_e, { zaloId, campaign }: { zaloId: string; campaign: any }) => {
        try {
            if (isEmployeeMode()) {
                // Ảnh trong mẫu tin là file trên máy nhân viên → upload lên Boss trước (hàng đợi gửi chạy trên Boss)
                const uploaded = await uploadCampaignImagesToBoss(campaign, zaloId);
                if (!uploaded.success) return uploaded;
                return await proxyToBossWithResult('crm:saveCampaign', { zaloId, campaign: uploaded.campaign });
            }
            const capability = validateCampaignForChannel(zaloId, campaign);
            if (!capability.allowed) return { success: false, error: capability.reason };
            const id = DatabaseService.getInstance().saveCRMCampaign({ ...campaign, owner_zalo_id: zaloId });
            if (!id) return { success: false, error: 'Không lưu được chiến dịch' };
            DatabaseService.getInstance().save();
            EventBroadcaster.emit('crm:campaignChanged', { action: 'save', ownerZaloId: zaloId, id, campaign: { ...campaign, id } });
            return { success: true, id };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:deleteCampaign', async (_e, { zaloId, campaignId }: { zaloId: string; campaignId: number }) => {
        try {
            if (isEmployeeMode()) return await proxyToBossWithResult('crm:deleteCampaign', { zaloId, campaignId });
            // deleteCRMCampaign xoá liên hệ theo campaignId trước khi xoá chiến dịch theo chủ → kiểm tra chủ trước
            const existing = DatabaseService.getInstance().getCRMCampaign(campaignId);
            if (!existing || existing.owner_zalo_id !== zaloId) return { success: false, error: 'Không tìm thấy chiến dịch' };
            DatabaseService.getInstance().deleteCRMCampaign(campaignId, zaloId);
            DatabaseService.getInstance().save();
            EventBroadcaster.emit('crm:campaignChanged', { action: 'delete', ownerZaloId: zaloId, campaignId });
            return { success: true };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:cloneCampaign', async (_e, { zaloId, campaignId, includeContacts, newName }: { zaloId: string; campaignId: number; includeContacts: boolean; newName?: string }) => {
        try {
            if (isEmployeeMode()) return await proxyToBossWithResult('crm:cloneCampaign', { zaloId, campaignId, includeContacts, newName });
            const db = DatabaseService.getInstance();
            const source = db.getCRMCampaign(campaignId);
            if (!source || source.owner_zalo_id !== zaloId) return { success: false, error: 'Không tìm thấy chiến dịch' };
            const capability = validateCampaignForChannel(zaloId, source);
            if (!capability.allowed) return { success: false, error: capability.reason };
            const newId = db.cloneCRMCampaign(campaignId, zaloId, includeContacts, newName);
            if (!newId) return { success: false, error: 'Không thể nhân bản chiến dịch' };
            db.save();
            EventBroadcaster.emit('crm:campaignChanged', { action: 'clone', ownerZaloId: zaloId, campaignId: newId });
            return { success: true, id: newId };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:updateCampaignStatus', async (_e, { campaignId, status }: { campaignId: number; status: string }) => {
        try {
            if (isEmployeeMode()) return await proxyToBossWithResult('crm:updateCampaignStatus', { campaignId, status });
            const db = DatabaseService.getInstance();
            const existing = db.getCRMCampaign(campaignId);
            if (!existing) return { success: false, error: 'Không tìm thấy chiến dịch' };
            const capability = validateCampaignForChannel(existing.owner_zalo_id, existing);
            if (!capability.allowed) return { success: false, error: capability.reason };
            db.updateCRMCampaignStatus(campaignId, status as any);
            db.save();
            // Start/stop queue
            const campaign = db.getCRMCampaign(campaignId);
            if (campaign) {
                if (status === 'active') CRMQueueService.getInstance().startForAccount(campaign.owner_zalo_id);
                else if (status === 'paused' || status === 'done') CRMQueueService.getInstance().checkAndStopIfIdle(campaign.owner_zalo_id);
                EventBroadcaster.emit('crm:campaignChanged', { action: 'status', ownerZaloId: campaign.owner_zalo_id, campaignId, status });
            }
            return { success: true };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:addCampaignContacts', async (_e, { zaloId, campaignId, contacts }: { zaloId: string; campaignId: number; contacts: any[] }) => {
        try {
            if (isEmployeeMode()) return await proxyToBossWithResult('crm:addCampaignContacts', { zaloId, campaignId, contacts });
            const campaign = DatabaseService.getInstance().getCRMCampaign(campaignId);
            if (!campaign || campaign.owner_zalo_id !== zaloId) return { success: false, error: 'Không tìm thấy chiến dịch' };
            const capability = validateCampaignForChannel(zaloId, campaign);
            if (!capability.allowed) return { success: false, error: capability.reason };
            DatabaseService.getInstance().addCampaignContacts(campaignId, zaloId, contacts);
            DatabaseService.getInstance().save();
            EventBroadcaster.emit('crm:campaignChanged', { action: 'contactsAdded', ownerZaloId: zaloId, campaignId });
            return { success: true };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:getCampaignContacts', async (_e, { campaignId }: { campaignId: number }) => {
        try { return { success: true, contacts: DatabaseService.getInstance().getCampaignContacts(campaignId) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    // Xoá liên hệ khỏi chiến dịch: trước đây chỉ xoá DB cục bộ (nhân viên: không bao giờ tới Boss) và không phát event
    // → màn chiến dịch của Boss / nhân viên khác không cập nhật.
    ipcMain.handle('crm:deleteCampaignContacts', async (_e, { campaignId, contactIds }: { campaignId: number; contactIds: string[] }) => {
        try {
            if (isEmployeeMode()) return await proxyToBossWithResult('crm:deleteCampaignContacts', { campaignId, contactIds });
            const campaign = DatabaseService.getInstance().getCRMCampaign(campaignId);
            if (!campaign) return { success: false, error: 'Không tìm thấy chiến dịch' };
            DatabaseService.getInstance().deleteCampaignContacts(campaignId, contactIds || []);
            EventBroadcaster.emit('crm:campaignChanged', { action: 'contactsRemoved', ownerZaloId: campaign.owner_zalo_id, campaignId });
            return { success: true };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:deleteAllCampaignContacts', async (_e, { campaignId }: { campaignId: number }) => {
        try {
            if (isEmployeeMode()) return await proxyToBossWithResult('crm:deleteAllCampaignContacts', { campaignId });
            const campaign = DatabaseService.getInstance().getCRMCampaign(campaignId);
            if (!campaign) return { success: false, error: 'Không tìm thấy chiến dịch' };
            DatabaseService.getInstance().deleteAllCampaignContacts(campaignId);
            EventBroadcaster.emit('crm:campaignChanged', { action: 'contactsRemoved', ownerZaloId: campaign.owner_zalo_id, campaignId });
            return { success: true };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    // ─── Send Log ──────────────────────────────────────────────────────────
    ipcMain.handle('crm:getSendLog', async (_e, { zaloId, opts }: { zaloId: string; opts?: any }) => {
        try {
            const capability = getCRMChannelDecision(zaloId, 'history');
            if (!capability.allowed) return { success: true, logs: [] };
            return { success: true, logs: DatabaseService.getInstance().getSendLog(zaloId, opts || {}) };
        }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:getCampaignStats', async (_e, { zaloId, limit }: { zaloId: string; limit?: number }) => {
        try { return { success: true, stats: DatabaseService.getInstance().getTopCampaignStats(zaloId, limit || 10) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:getActivityStats', async (_e, { zaloId, sinceTs, untilTs }: { zaloId: string; sinceTs: number; untilTs?: number }) => {
        try { return { success: true, ...DatabaseService.getInstance().getActivityStats(zaloId, sinceTs, untilTs) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    // ─── Queue status ──────────────────────────────────────────────────────────
    ipcMain.handle('crm:getQueueStatus', async (_e, { zaloId }: { zaloId: string }) => {
        try { return { success: true, status: CRMQueueService.getInstance().getStatus(zaloId) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    // ─── Analytics / Reporting ─────────────────────────────────────────────────
    ipcMain.handle('analytics:dashboardOverview', async (_e, { zaloId, sinceTs, untilTs, threadType }: { zaloId: string; sinceTs?: number; untilTs?: number; threadType?: number }) => {
        try { return { success: true, ...DatabaseService.getInstance().getDashboardOverview(zaloId, sinceTs, untilTs, threadType) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('analytics:messageVolume', async (_e, { zaloId, sinceTs, untilTs, granularity, threadType }: { zaloId: string; sinceTs: number; untilTs: number; granularity: 'hour' | 'day'; threadType?: number }) => {
        try { return { success: true, data: DatabaseService.getInstance().getMessageVolume(zaloId, sinceTs, untilTs, granularity, threadType) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('analytics:peakHours', async (_e, { zaloId, sinceTs, untilTs, threadType }: { zaloId: string; sinceTs: number; untilTs: number; threadType?: number }) => {
        try { return { success: true, data: DatabaseService.getInstance().getPeakHoursHeatmap(zaloId, sinceTs, untilTs, threadType) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('analytics:contactGrowth', async (_e, { zaloId, sinceTs, untilTs }: { zaloId: string; sinceTs: number; untilTs: number }) => {
        try { return { success: true, data: DatabaseService.getInstance().getContactGrowth(zaloId, sinceTs, untilTs) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('analytics:contactSegmentation', async (_e, { zaloId }: { zaloId: string }) => {
        try { return { success: true, ...DatabaseService.getInstance().getContactSegmentation(zaloId) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('analytics:campaignComparison', async (_e, { zaloId }: { zaloId: string }) => {
        try { return { success: true, data: DatabaseService.getInstance().getCampaignComparison(zaloId) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('analytics:friendRequests', async (_e, { zaloId, sinceTs, untilTs }: { zaloId: string; sinceTs: number; untilTs: number }) => {
        try { return { success: true, ...DatabaseService.getInstance().getFriendRequestAnalytics(zaloId, sinceTs, untilTs) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    // zaloIds (Reports, several accounts): one query — a workflow attached to several of them counts once.
    ipcMain.handle('analytics:workflowAnalytics', async (_e, { zaloId, zaloIds, sinceTs, untilTs }: { zaloId?: string; zaloIds?: string[]; sinceTs: number; untilTs: number }) => {
        try { return { success: true, ...DatabaseService.getInstance().getWorkflowAnalytics(Array.isArray(zaloIds) && zaloIds.length > 0 ? zaloIds.map(String) : zaloId, sinceTs, untilTs) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('analytics:aiAnalytics', async (_e, { sinceTs, untilTs }: { sinceTs: number; untilTs: number }) => {
        try { return { success: true, ...DatabaseService.getInstance().getAIAnalytics(sinceTs, untilTs) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    // zaloIds (Reports, several accounts): one query — median / min / max over all their replies.
    ipcMain.handle('analytics:responseTime', async (_e, { zaloId, zaloIds, sinceTs, untilTs, threadType }: { zaloId?: string; zaloIds?: string[]; sinceTs: number; untilTs: number; threadType?: number }) => {
        try { return { success: true, ...DatabaseService.getInstance().getResponseTimeStats(Array.isArray(zaloIds) && zaloIds.length > 0 ? zaloIds.map(String) : zaloId, sinceTs, untilTs, threadType) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('analytics:labelUsage', async (_e, { zaloId, sinceTs, untilTs }: { zaloId: string; sinceTs: number; untilTs: number }) => {
        try { return { success: true, ...DatabaseService.getInstance().getLabelUsageAnalytics(zaloId, sinceTs, untilTs) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });
}

