export type AIModelPlatform =
  | 'openai' | 'gemini' | 'claude' | 'deepseek' | 'grok'
  | 'mistral' | 'openrouter' | '9router';

export interface AIModelOption {
  value: string;
  label: string;
}

/** Models verified by the GenAI integration. Keep provider API IDs exact. */
export const AI_MODEL_OPTIONS: Record<AIModelPlatform, AIModelOption[]> = {
  openai: [
    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { value: 'gpt-6-luna', label: 'GPT-6 Luna' },
    { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
    { value: 'gpt-4o', label: 'GPT-4o' },
  ],
  gemini: [
    { value: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' },
    { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
    { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
    { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
  ],
  claude: [
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { value: 'claude-opus-5', label: 'Claude Opus 5' },
    { value: 'claude-fable-5', label: 'Claude Fable 5' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { value: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  ],
  deepseek: [
    { value: 'deepseek-flash', label: 'DeepSeek Flash' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  ],
  grok: [
    { value: 'grok-4.6', label: 'Grok 4.6' },
    { value: 'grok-4.5', label: 'Grok 4.5' },
    { value: 'grok-4.3', label: 'Grok 4.3' },
  ],
  // Mistral and OpenRouter allow custom API model IDs; keep stable defaults.
  mistral: [
    { value: 'mistral-large-latest', label: 'Mistral Large' },
    { value: 'mistral-small-latest', label: 'Mistral Small' },
    { value: 'codestral-latest', label: 'Codestral' },
  ],
  openrouter: [
    { value: 'openrouter/auto', label: 'OpenRouter Auto' },
  ],
  '9router': [],
};

export const DEFAULT_AI_MODELS: Record<AIModelPlatform, string> = Object.fromEntries(
  Object.entries(AI_MODEL_OPTIONS).map(([platform, options]) => [platform, options[0]?.value || '']),
) as Record<AIModelPlatform, string>;

const LEGACY_MODEL_ALIASES: Record<string, string> = {
  // OpenAI
  'gpt-5.4': 'gpt-5.6-luna', 'gpt-5.4-pro': 'gpt-5.6-luna',
  'gpt-5.4-mini': 'gpt-5.6-luna', 'gpt-5.4-nano': 'gpt-5.6-luna',
  'gpt-5': 'gpt-5.6-luna', 'gpt-5-mini': 'gpt-5.6-luna', 'gpt-5-nano': 'gpt-5.6-luna',
  'gpt-4.1': 'gpt-5.6-luna', 'gpt-4o': 'gpt-5.6-luna', 'gpt-4o-mini': 'gpt-5.6-luna',
  'o3': 'gpt-5.6-luna', 'o3-mini': 'gpt-5.6-luna', 'o4-mini': 'gpt-5.6-luna', 'gpt-3.5-turbo': 'gpt-5.6-luna',
  // Gemini
  'gemini-3.1-pro': 'gemini-3.7-flash', 'gemini-3.1-flash': 'gemini-3.7-flash',
  'gemini-3-flash-preview': 'gemini-3.7-flash', 'gemini-3.0-flash': 'gemini-3.7-flash',
  'gemini-3.0-flash-lite': 'gemini-3.7-flash', 'gemini-2.5-pro': 'gemini-3.7-flash',
  'gemini-2.5-flash': 'gemini-3.7-flash', 'gemini-pro': 'gemini-3.7-flash',
  // Claude
  // Keep historical UI choices working by routing their retired IDs to the
  // current equivalent API model.
  'claude-sonnet-5': 'claude-sonnet-5-5', 'claude-opus-5': 'claude-opus-5-5',
  'claude-fable-5': 'claude-fable-5-1',
  'claude-4.6-sonnet-20260301': 'claude-sonnet-5-5', 'claude-4.5-sonnet-20260115': 'claude-sonnet-5-5',
  'claude-4.0-haiku-20260101': 'claude-haiku-4-5-20251001', 'claude-4.0-opus-20260101': 'claude-opus-5-5',
  'claude-sonnet-4-20250514': 'claude-sonnet-5-5', 'claude-3-5-haiku-20241022': 'claude-haiku-4-5-20251001',
  'claude-2': 'claude-sonnet-5-5', 'claude-instant-1': 'claude-haiku-4-5-20251001',
  // DeepSeek
  // These two were release/version display names, never valid API model IDs.
  'DeepSeek-V4-Flash-0731': 'deepseek-flash',
  'DeepSeek-V4-Pro-0813': 'deepseek-v4-pro',
  'deepseek-v4-flash-0731': 'deepseek-flash',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash', 'deepseek-reasoner': 'deepseek-v4-pro',
  'deepseek-chat-v3.2': 'deepseek-flash', 'deepseek-chat-v3.1': 'deepseek-flash',
  'deepseek-reasoner-r1.5': 'deepseek-v4-pro',
  // Grok and Mistral
  'grok-4': 'grok-4.6', 'grok-4-fast': 'grok-4.6', 'grok-4-mini': 'grok-4.6',
  'grok-4-mini-fast': 'grok-4.6', 'grok-3': 'grok-4.6', 'grok-3-mini': 'grok-4.6',
  'mistral-large-2-latest': 'mistral-large-latest', 'mistral-medium-latest': 'mistral-large-latest',
  'mistral-small-3-latest': 'mistral-large-latest', 'codestral-2-latest': 'mistral-large-latest',
};

export function normalizeAIModel(platform: string, requestedModel?: string | null): string {
  const normalizedPlatform = platform.toLowerCase() as AIModelPlatform;
  const requested = String(requestedModel || '').trim();
  if (LEGACY_MODEL_ALIASES[requested] || LEGACY_MODEL_ALIASES[requested.toLowerCase()]) {
    return LEGACY_MODEL_ALIASES[requested] || LEGACY_MODEL_ALIASES[requested.toLowerCase()];
  }
  const supported = AI_MODEL_OPTIONS[normalizedPlatform];
  if (!supported) return requested;
  if (supported.some(option => option.value === requested)) return requested;
  // Proxy platforms deliberately allow models outside the curated list.
  if ((normalizedPlatform === 'openrouter' || normalizedPlatform === '9router') && requested) return requested;
  return DEFAULT_AI_MODELS[normalizedPlatform];
}
