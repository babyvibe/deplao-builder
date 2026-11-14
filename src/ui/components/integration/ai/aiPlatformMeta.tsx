import React from 'react';
import { AlertIcon, BotIcon, LightningIcon, RefreshIcon, ShuffleIcon, SparklesIcon, TargetIcon } from '@/components/common/icons';

export interface AIPlatformMeta {
  label: string;
  color: string;
  icon: React.ReactNode;
}

/**
 * Short labels, colors and icons of the 8 AI platforms (same list as PLATFORMS in AIAssistantDetailPage).
 * Shared by the assistant cards (AI Assistant page, the All tab of Integrations) and the Assign-by-account popup.
 * Each place used to keep its own copy and was missing Mistral / 9Router / OpenRouter, so those platforms' cards showed the "OpenAI" label.
 */
export const AI_PLATFORM_META: Record<string, AIPlatformMeta> = {
  openai:     { label: 'OpenAI',     color: 'bg-green-600',  icon: <BotIcon className="w-4 h-4" /> },
  gemini:     { label: 'Gemini',     color: 'bg-blue-600',   icon: <SparklesIcon className="w-4 h-4" /> },
  claude:     { label: 'Claude',     color: 'bg-amber-600',  icon: <AlertIcon className="w-4 h-4" /> },
  deepseek:   { label: 'DeepSeek',   color: 'bg-purple-600', icon: <TargetIcon className="w-4 h-4" /> },
  grok:       { label: 'Grok',       color: 'bg-orange-600', icon: <LightningIcon className="w-4 h-4" /> },
  mistral:    { label: 'Mistral',    color: 'bg-sky-600',    icon: <RefreshIcon className="w-4 h-4" /> },
  '9router':  { label: '9Router',    color: 'bg-cyan-600',   icon: <ShuffleIcon className="w-4 h-4" /> },
  openrouter: { label: 'OpenRouter', color: 'bg-indigo-600', icon: <ShuffleIcon className="w-4 h-4" /> },
};

/** Unknown platforms (old builds, imported data) fall back to OpenAI as before. */
export function getAIPlatformMeta(platform?: string | null): AIPlatformMeta {
  return AI_PLATFORM_META[platform || ''] || AI_PLATFORM_META.openai;
}
