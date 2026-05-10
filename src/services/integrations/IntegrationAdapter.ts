// Integration adapter interface and shared types

export type IntegrationType =
  | 'kiotviet'
  | 'haravan'
  | 'sapo'
  | 'ipos'
  | 'nhanh'
  | 'pancake'
  | 'casso'
  | 'sepay'
  | 'ghn'
  | 'ghtk'
  | string;

export interface IntegrationConfig {
  id: string;
  type: IntegrationType;
  name: string;
  enabled: boolean;
  /** Credentials are stored encrypted; decrypted at runtime */
  credentials: Record<string, string>;
  settings: Record<string, any>;
  connectedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface TestResult {
  success: boolean;
  message: string;
}

export abstract class IntegrationAdapter {
  abstract readonly type: string;
  abstract readonly name: string;
  protected config: IntegrationConfig;

  constructor(config: IntegrationConfig) {
    this.config = config;
  }

  updateConfig(config: IntegrationConfig): void {
    this.config = config;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  abstract testConnection(): Promise<TestResult>;
  abstract executeAction(action: string, params: Record<string, any>): Promise<any>;
}

