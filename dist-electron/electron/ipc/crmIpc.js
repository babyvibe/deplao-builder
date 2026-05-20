"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCRMIpc = registerCRMIpc;
const electron_1 = require("electron");
const DatabaseService_1 = __importDefault(require("../../src/services/DatabaseService"));
const CRMQueueService_1 = __importDefault(require("../../src/services/CRMQueueService"));
function registerCRMIpc() {
    // ─── Notes ─────────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('crm:getNotes', async (_e, { zaloId, contactId }) => {
        try {
            return { success: true, notes: DatabaseService_1.default.getInstance().getCRMNotes(zaloId, contactId) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('crm:saveNote', async (_e, { zaloId, note }) => {
        try {
            const id = DatabaseService_1.default.getInstance().saveCRMNote({ ...note, owner_zalo_id: zaloId });
            DatabaseService_1.default.getInstance().save();
            return { success: true, id };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('crm:deleteNote', async (_e, { zaloId, noteId }) => {
        try {
            DatabaseService_1.default.getInstance().deleteCRMNote(noteId, zaloId);
            DatabaseService_1.default.getInstance().save();
            return { success: true };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    // ─── Contacts ──────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('crm:getContacts', async (_e, { zaloId, opts }) => {
        try {
            return { success: true, ...DatabaseService_1.default.getInstance().getCRMContacts(zaloId, opts || {}) };
        }
        catch (e) {
            return { success: false, error: e.message, contacts: [], total: 0 };
        }
    });
    electron_1.ipcMain.handle('crm:getContactStats', async (_e, { zaloId }) => {
        try {
            return { success: true, ...DatabaseService_1.default.getInstance().getContactStats(zaloId) };
        }
        catch (e) {
            return { success: false, error: e.message, total: 0, friendCount: 0, noteCount: 0 };
        }
    });
    // ─── Campaigns ─────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('crm:getCampaigns', async (_e, { zaloId }) => {
        try {
            return { success: true, campaigns: DatabaseService_1.default.getInstance().getCRMCampaigns(zaloId) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('crm:saveCampaign', async (_e, { zaloId, campaign }) => {
        try {
            const id = DatabaseService_1.default.getInstance().saveCRMCampaign({ ...campaign, owner_zalo_id: zaloId });
            DatabaseService_1.default.getInstance().save();
            return { success: true, id };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('crm:deleteCampaign', async (_e, { zaloId, campaignId }) => {
        try {
            DatabaseService_1.default.getInstance().deleteCRMCampaign(campaignId, zaloId);
            DatabaseService_1.default.getInstance().save();
            return { success: true };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('crm:cloneCampaign', async (_e, { zaloId, campaignId, includeContacts, newName }) => {
        try {
            const db = DatabaseService_1.default.getInstance();
            const newId = db.cloneCRMCampaign(campaignId, zaloId, includeContacts, newName);
            if (!newId)
                return { success: false, error: 'Không thể nhân bản chiến dịch' };
            db.save();
            return { success: true, id: newId };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('crm:updateCampaignStatus', async (_e, { campaignId, status }) => {
        try {
            const db = DatabaseService_1.default.getInstance();
            db.updateCRMCampaignStatus(campaignId, status);
            db.save();
            // Start/stop queue
            const campaign = db.getCRMCampaign(campaignId);
            if (campaign) {
                if (status === 'active')
                    CRMQueueService_1.default.getInstance().startForAccount(campaign.owner_zalo_id);
                else if (status === 'paused' || status === 'done')
                    CRMQueueService_1.default.getInstance().checkAndStopIfIdle(campaign.owner_zalo_id);
            }
            return { success: true };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('crm:addCampaignContacts', async (_e, { zaloId, campaignId, contacts }) => {
        try {
            DatabaseService_1.default.getInstance().addCampaignContacts(campaignId, zaloId, contacts);
            DatabaseService_1.default.getInstance().save();
            return { success: true };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('crm:getCampaignContacts', async (_e, { campaignId }) => {
        try {
            return { success: true, contacts: DatabaseService_1.default.getInstance().getCampaignContacts(campaignId) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    // ─── Send Log ──────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('crm:getSendLog', async (_e, { zaloId, opts }) => {
        try {
            return { success: true, logs: DatabaseService_1.default.getInstance().getSendLog(zaloId, opts || {}) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('crm:getCampaignStats', async (_e, { zaloId, limit }) => {
        try {
            return { success: true, stats: DatabaseService_1.default.getInstance().getTopCampaignStats(zaloId, limit || 10) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('crm:getActivityStats', async (_e, { zaloId, sinceTs, untilTs }) => {
        try {
            return { success: true, ...DatabaseService_1.default.getInstance().getActivityStats(zaloId, sinceTs, untilTs) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    // ─── Queue status ──────────────────────────────────────────────────────────
    electron_1.ipcMain.handle('crm:getQueueStatus', async (_e, { zaloId }) => {
        try {
            return { success: true, status: CRMQueueService_1.default.getInstance().getStatus(zaloId) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    // ─── Analytics / Reporting ─────────────────────────────────────────────────
    electron_1.ipcMain.handle('analytics:dashboardOverview', async (_e, { zaloId }) => {
        try {
            return { success: true, ...DatabaseService_1.default.getInstance().getDashboardOverview(zaloId) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('analytics:messageVolume', async (_e, { zaloId, sinceTs, untilTs, granularity, threadType }) => {
        try {
            return { success: true, data: DatabaseService_1.default.getInstance().getMessageVolume(zaloId, sinceTs, untilTs, granularity, threadType) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('analytics:peakHours', async (_e, { zaloId, sinceTs, untilTs, threadType }) => {
        try {
            return { success: true, data: DatabaseService_1.default.getInstance().getPeakHoursHeatmap(zaloId, sinceTs, untilTs, threadType) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('analytics:contactGrowth', async (_e, { zaloId, sinceTs, untilTs }) => {
        try {
            return { success: true, data: DatabaseService_1.default.getInstance().getContactGrowth(zaloId, sinceTs, untilTs) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('analytics:contactSegmentation', async (_e, { zaloId }) => {
        try {
            return { success: true, ...DatabaseService_1.default.getInstance().getContactSegmentation(zaloId) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('analytics:campaignComparison', async (_e, { zaloId }) => {
        try {
            return { success: true, data: DatabaseService_1.default.getInstance().getCampaignComparison(zaloId) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('analytics:friendRequests', async (_e, { zaloId, sinceTs, untilTs }) => {
        try {
            return { success: true, ...DatabaseService_1.default.getInstance().getFriendRequestAnalytics(zaloId, sinceTs, untilTs) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('analytics:workflowAnalytics', async (_e, { zaloId, sinceTs, untilTs }) => {
        try {
            return { success: true, ...DatabaseService_1.default.getInstance().getWorkflowAnalytics(zaloId, sinceTs, untilTs) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('analytics:aiAnalytics', async (_e, { sinceTs, untilTs }) => {
        try {
            return { success: true, ...DatabaseService_1.default.getInstance().getAIAnalytics(sinceTs, untilTs) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('analytics:responseTime', async (_e, { zaloId, sinceTs, untilTs, threadType }) => {
        try {
            return { success: true, ...DatabaseService_1.default.getInstance().getResponseTimeStats(zaloId, sinceTs, untilTs, threadType) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('analytics:labelUsage', async (_e, { zaloId, sinceTs, untilTs }) => {
        try {
            return { success: true, ...DatabaseService_1.default.getInstance().getLabelUsageAnalytics(zaloId, sinceTs, untilTs) };
        }
        catch (e) {
            return { success: false, error: e.message };
        }
    });
}
//# sourceMappingURL=crmIpc.js.map