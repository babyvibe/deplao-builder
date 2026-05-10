import { create } from 'zustand';

export interface CRMNote {
  id: number;
  owner_zalo_id: string;
  contact_id: string;
  /** 'user' | 'group' */
  contact_type?: string;
  content: string;
  /** topicId Zalo trả về khi tạo/sửa ghi chú nhóm */
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
  created_at: number;
  updated_at: number;
  total_contacts: number;
  sent_count: number;
  pending_count: number;
  failed_count: number;
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
  /** 0 = Nam, 1 = Nữ, null = chưa biết */
  gender?: number | null;
  /** DD/MM/YYYY format */
  birthday?: string | null;
}

export type CRMTabView = 'contacts' | 'campaigns' | 'history' | 'groups' | 'search' | 'requests';

export type ContactTypeFilter = 'friend' | 'group' | 'non_friend' | 'has_phone' | 'has_notes';

/** 'all' = tất cả, 'male' = Nam (gender=0), 'female' = Nữ (gender=1), 'unknown' = chưa xác định */
export type GenderFilter = 'all' | 'male' | 'female' | 'unknown';

/** 'all' = tất cả, 'has_birthday' = có ngày sinh, 'no_birthday' = chưa có, 'today' = hôm nay, 'this_week' = tuần này, 'this_month' = tháng này */
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
  queueStatus: Record<string, { running: boolean; tokens: number; maxTokens: number; lastSentAt: number }>;
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
  setFilter: (f: Partial<Pick<CRMStore, 'searchText' | 'filterLabelIds' | 'filterLocalLabelIds' | 'filterContactTypes' | 'filterGender' | 'filterBirthday' | 'sortBy' | 'sortDir' | 'page'>>) => void;
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
  pageSize: 500,
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

