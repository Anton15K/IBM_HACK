import type { NodeStatus, Priority } from '../types';

export function statusColor(status: NodeStatus, priority: Priority): string {
  if (priority === 'critical') return '#F87171';
  switch (status) {
    case 'done': return '#34D399';
    case 'running': return '#60A5FA';
    case 'failed': return '#F87171';
    case 'rework': return '#FBBF24';
    case 'needs_approval': return '#FBBF24';
    case 'ready': return '#5B8CFF';
    case 'blocked': return '#5B7A99';
    case 'queued': return '#8B94A7';
    default: return '#4B5563';
  }
}

export function statusLabel(status: NodeStatus): string {
  switch (status) {
    case 'draft': return 'Draft';
    case 'ready': return 'Ready';
    case 'queued': return 'Queued';
    case 'running': return 'Running';
    case 'blocked': return 'Blocked';
    case 'done': return 'Done';
    case 'failed': return 'Failed';
    case 'rework': return 'Rework';
    case 'needs_approval': return 'Approval';
  }
}

export function priorityColor(priority: Priority): string {
  switch (priority) {
    case 'critical': return '#F87171';
    case 'high': return '#FBBF24';
    case 'normal': return '#8B94A7';
    case 'low': return '#4B5563';
  }
}

export const PROVIDER_LABELS: Record<string, string> = {
  bob: 'Bob',
  api: 'API model',
  openai: 'OpenAI',
  anthropic: 'Claude',
  google: 'Gemini',
  mock: 'Mock',
};

export const NODE_TYPE_LABELS: Record<string, string> = {
  worker: 'Worker',
  gate: 'Gate',
  inbox: 'Inbox',
};
