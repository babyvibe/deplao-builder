import { create } from 'zustand';

export interface CRMNote {
  id: number;
  owner_zalo_id: string;
  contact_id: string;
  /** 'user' | 'group' */
  contact_type?: string;
  content: string;
  /** topicId that Zalo returns when a group note is created / edited */
  topic_id?: string | null;
  created_at: number;
  updated_at: number;
}

export type CRMCampaignType = 'message' | 'friend_request' | 'mixed' | 'invite_to_group';

export interface CRMCampaign {
  id: number;
  owner_zalo_id: string;
  name: string;
  template_message: string;
  friend_request_message: string;
  campaign_type: CRMCampaignType;
  mixed_config: string;
  status: 'draft' | 'active' | 'paused' | 'done';
  delay_seconds: number;
  /** Delay range: min seconds between sends */
  delay_min_seconds: number;
  /** Delay range: max seconds between sends */
  delay_max_seconds: number;
  /** Per-contact delay min (0 = use delay_min_seconds) */
  per_contact_delay_min_seconds: number;
  /** Per-contact delay max (0 = use per_contact_delay_min_seconds) */
  per_contact_delay_max_seconds: number;
  daily_send_limit: number;    // 0 = no limit
  daily_start_time: string;    // "HH:MM" format
  /** Auto-stop after N failed contacts in a row; 0 / missing (old owner's machine version) = never stop */
  stop_after_failures?: number;
  consecutive_failures?: number;
  /** Reason the campaign auto-stopped ('' = not stopped); stays until Continue is clicked */
  auto_stop_reason?: string;
  auto_stopped_at?: number;
  /** Auto-stop: count only strangers / resume tomorrow (0 / 1); auto-resume time (0 = not scheduled) */
  stop_strangers_only?: number;
  stop_resume_next_day?: number;
  auto_resume_at?: number;
  /** "Gắn nhãn khi gửi thành công": JSON arrays of local / Zalo label ids (services/crm/campaignLabels) */
  success_local_labels?: string;
  success_zalo_labels?: string;
  created_at: number;
  updated_at: number;
  total_contacts: number;
  sent_count: number;
  pending_count: number;
  failed_count: number;
  sent_today_count: number;    // computed: sent today
}

export interface CRMContact {
  contact_id: string;
  display_name: string;
  alias: string;
  avatar: string;
  phone: string;
  is_friend: number;
  contact_type: string;
  last_message_time: number;
  note_count: number;
  /** 0 = Male, 1 = Female, null = unknown */
  gender?: number | null;
  /** DD/MM/YYYY format */
  birthday?: string | null;
  /** Last time the name/avatar was refreshed in bulk from the API (unix ms); 0/undefined = never */
  info_refreshed_at?: number;
}

export type CRMTabView = 'contacts' | 'campaigns' | 'history' | 'groups' | 'search' | 'requests' | 'scan' | 'scan_history' | 'scan_stats';

export type ContactTypeFilter = 'friend' | 'group' | 'non_friend' | 'has_phone' | 'has_notes';

/** 'all' = all, 'male' = Male (gender=0), 'female' = Female (gender=1), 'unknown' = not set */
export type GenderFilter = 'all' | 'male' | 'female' | 'unknown';

/** 'all' = all, 'has_birthday' = has a birthday, 'no_birthday' = none yet, 'today' = today, 'this_week' = this week, 'this_month' = this month */
export type BirthdayFilter = 'all' | 'has_birthday' | 'no_birthday' | 'today' | 'this_week' | 'this_month';

interface CRMStore {
  tab: CRMTabView;
  contacts: CRMContact[];
  totalContacts: number;
  campaigns: CRMCampaign[];
  selectedContactIds: Set<string>;
  activeContactId: string | null;
  activeCampaignId: number | null;
  // Filter state
  searchText: string;
  filterLabelIds: number[];
  filterLocalLabelIds: number[];
  filterContactTypes: ContactTypeFilter[];
  filterGender: GenderFilter;
  filterBirthday: BirthdayFilter;
  sortBy: 'name' | 'last_message';
  sortDir: 'asc' | 'desc';
  page: number;
  pageSize: number;
  // Loading
  contactsLoading: boolean;
  campaignsLoading: boolean;
  // Queue status per account
  queueStatus: Record<string, { running: boolean; tokens: number; maxTokens: number; lastSentAt: number; dailyPaused?: boolean }>;
  groupCount: number;
  requestCount: number;

  setTab: (tab: CRMTabView) => void;
  setContacts: (contacts: CRMContact[], total: number) => void;
  setCampaigns: (campaigns: CRMCampaign[]) => void;
  toggleSelectContact: (id: string) => void;
  selectAllContacts: (ids: string[]) => void;
  clearSelection: () => void;
  setActiveContact: (id: string | null) => void;
  setActiveCampaign: (id: number | null) => void;
  setFilter: (f: Partial<Pick<CRMStore, 'searchText' | 'filterLabelIds' | 'filterLocalLabelIds' | 'filterContactTypes' | 'filterGender' | 'filterBirthday' | 'sortBy' | 'sortDir' | 'page' | 'pageSize'>>) => void;
  setContactsLoading: (v: boolean) => void;
  setCampaignsLoading: (v: boolean) => void;
  updateQueueStatus: (zaloId: string, status: any) => void;
  updateCampaignInList: (campaign: Partial<CRMCampaign> & { id: number }) => void;
  setGroupCount: (n: number) => void;
  setRequestCount: (n: number) => void;
}

export const useCRMStore = create<CRMStore>((set) => ({
  tab: 'contacts',
  contacts: [],
  totalContacts: 0,
  campaigns: [],
  selectedContactIds: new Set(),
  activeContactId: null,
  activeCampaignId: null,
  searchText: '',
  filterLabelIds: [],
  filterLocalLabelIds: [],
  filterContactTypes: [],
  filterGender: 'all',
  filterBirthday: 'all',
  sortBy: 'name',
  sortDir: 'asc',
  page: 0,
  pageSize: 200,
  contactsLoading: false,
  campaignsLoading: false,
  queueStatus: {},
  groupCount: 0,
  requestCount: 0,

  setTab: (tab) => set({ tab }),
  setContacts: (contacts, totalContacts) => set({ contacts, totalContacts }),
  setCampaigns: (campaigns) => set({ campaigns }),
  toggleSelectContact: (id) => set((s) => {
    const next = new Set(s.selectedContactIds);
    next.has(id) ? next.delete(id) : next.add(id);
    return { selectedContactIds: next };
  }),
  selectAllContacts: (ids) => set({ selectedContactIds: new Set(ids) }),
  clearSelection: () => set({ selectedContactIds: new Set() }),
  setActiveContact: (id) => set({ activeContactId: id }),
  setActiveCampaign: (id) => set({ activeCampaignId: id }),
  setFilter: (f) => set((s) => ({ ...s, ...f, page: f.page ?? 0 })),
  setContactsLoading: (v) => set({ contactsLoading: v }),
  setCampaignsLoading: (v) => set({ campaignsLoading: v }),
  updateQueueStatus: (zaloId, status) => set((s) => ({ queueStatus: { ...s.queueStatus, [zaloId]: status } })),
  updateCampaignInList: (updated) => set((s) => ({
    campaigns: s.campaigns.map(c => c.id === updated.id ? { ...c, ...updated } : c),
  })),
  setGroupCount: (n) => set({ groupCount: n }),
  setRequestCount: (n) => set({ requestCount: n }),
}));

