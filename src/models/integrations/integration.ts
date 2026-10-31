export interface Integration {
    id: string;
    type: string;
    name: string;
    enabled: number;
    credentials_encrypted: string;
    settings: string;
    connected_at?: number;
    created_at: number;
    updated_at: number;
}
