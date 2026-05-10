import { ipcMain } from 'electron';
import DatabaseService from '../../src/services/DatabaseService';
import CRMQueueService from '../../src/services/CRMQueueService';

export function registerCRMIpc(): void {


    // ─── Notes ─────────────────────────────────────────────────────────────
    ipcMain.handle('crm:getNotes', async (_e, { zaloId, contactId }: { zaloId: string; contactId: string }) => {
        try { return { success: true, notes: DatabaseService.getInstance().getCRMNotes(zaloId, contactId) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:saveNote', async (_e, { zaloId, note }: { zaloId: string; note: any }) => {
        try {
            const id = DatabaseService.getInstance().saveCRMNote({ ...note, owner_zalo_id: zaloId });
            DatabaseService.getInstance().save();
            return { success: true, id };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:deleteNote', async (_e, { zaloId, noteId }: { zaloId: string; noteId: number }) => {
        try {
            DatabaseService.getInstance().deleteCRMNote(noteId, zaloId);
            DatabaseService.getInstance().save();
            return { success: true };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    // ─── Contacts ──────────────────────────────────────────────────────────
    ipcMain.handle('crm:getContacts', async (_e, { zaloId, opts }: { zaloId: string; opts?: any }) => {
        try { return { success: true, ...DatabaseService.getInstance().getCRMContacts(zaloId, opts || {}) }; }
        catch (e: any) { return { success: false, error: e.message, contacts: [], total: 0 }; }
    });

    ipcMain.handle('crm:getContactStats', async (_e, { zaloId }: { zaloId: string }) => {
        try { return { success: true, ...DatabaseService.getInstance().getContactStats(zaloId) }; }
        catch (e: any) { return { success: false, error: e.message, total: 0, friendCount: 0, noteCount: 0 }; }
    });

    // ─── Campaigns ─────────────────────────────────────────────────────────
    ipcMain.handle('crm:getCampaigns', async (_e, { zaloId }: { zaloId: string }) => {
        try { return { success: true, campaigns: DatabaseService.getInstance().getCRMCampaigns(zaloId) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:saveCampaign', async (_e, { zaloId, campaign }: { zaloId: string; campaign: any }) => {
        try {
            const id = DatabaseService.getInstance().saveCRMCampaign({ ...campaign, owner_zalo_id: zaloId });
            DatabaseService.getInstance().save();
            return { success: true, id };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:deleteCampaign', async (_e, { zaloId, campaignId }: { zaloId: string; campaignId: number }) => {
        try {
            DatabaseService.getInstance().deleteCRMCampaign(campaignId, zaloId);
            DatabaseService.getInstance().save();
            return { success: true };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:cloneCampaign', async (_e, { zaloId, campaignId, includeContacts, newName }: { zaloId: string; campaignId: number; includeContacts: boolean; newName?: string }) => {
        try {
            const db = DatabaseService.getInstance();
            const newId = db.cloneCRMCampaign(campaignId, zaloId, includeContacts, newName);
            if (!newId) return { success: false, error: 'Không thể nhân bản chiến dịch' };
            db.save();
            return { success: true, id: newId };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:updateCampaignStatus', async (_e, { campaignId, status }: { campaignId: number; status: string }) => {
        try {
            const db = DatabaseService.getInstance();
            db.updateCRMCampaignStatus(campaignId, status as any);
            db.save();
            // Start/stop queue
            const campaign = db.getCRMCampaign(campaignId);
            if (campaign) {
                if (status === 'active') CRMQueueService.getInstance().startForAccount(campaign.owner_zalo_id);
                else if (status === 'paused' || status === 'done') CRMQueueService.getInstance().checkAndStopIfIdle(campaign.owner_zalo_id);
            }
            return { success: true };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:addCampaignContacts', async (_e, { zaloId, campaignId, contacts }: { zaloId: string; campaignId: number; contacts: any[] }) => {
        try {
            DatabaseService.getInstance().addCampaignContacts(campaignId, zaloId, contacts);
            DatabaseService.getInstance().save();
            return { success: true };
        } catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('crm:getCampaignContacts', async (_e, { campaignId }: { campaignId: number }) => {
        try { return { success: true, contacts: DatabaseService.getInstance().getCampaignContacts(campaignId) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    // ─── Send Log ──────────────────────────────────────────────────────────
    ipcMain.handle('crm:getSendLog', async (_e, { zaloId, opts }: { zaloId: string; opts?: any }) => {
        try { return { success: true, logs: DatabaseService.getInstance().getSendLog(zaloId, opts || {}) }; }
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
    ipcMain.handle('analytics:dashboardOverview', async (_e, { zaloId }: { zaloId: string }) => {
        try { return { success: true, ...DatabaseService.getInstance().getDashboardOverview(zaloId) }; }
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

    ipcMain.handle('analytics:workflowAnalytics', async (_e, { zaloId, sinceTs, untilTs }: { zaloId: string; sinceTs: number; untilTs: number }) => {
        try { return { success: true, ...DatabaseService.getInstance().getWorkflowAnalytics(zaloId, sinceTs, untilTs) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('analytics:aiAnalytics', async (_e, { sinceTs, untilTs }: { sinceTs: number; untilTs: number }) => {
        try { return { success: true, ...DatabaseService.getInstance().getAIAnalytics(sinceTs, untilTs) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('analytics:responseTime', async (_e, { zaloId, sinceTs, untilTs, threadType }: { zaloId: string; sinceTs: number; untilTs: number; threadType?: number }) => {
        try { return { success: true, ...DatabaseService.getInstance().getResponseTimeStats(zaloId, sinceTs, untilTs, threadType) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });

    ipcMain.handle('analytics:labelUsage', async (_e, { zaloId, sinceTs, untilTs }: { zaloId: string; sinceTs: number; untilTs: number }) => {
        try { return { success: true, ...DatabaseService.getInstance().getLabelUsageAnalytics(zaloId, sinceTs, untilTs) }; }
        catch (e: any) { return { success: false, error: e.message }; }
    });
}

