import React from 'react';
import { useTranslations } from 'next-intl';
import type { ProjectStatus, ProjectPriority } from '@/types/project';

const STATUS_STYLES: Record<ProjectStatus, string> = {
  PLANNING: 'bg-status-info-bg text-status-info',
  ACTIVE: 'bg-status-success-bg text-status-success',
  ON_HOLD: 'bg-status-warning-bg text-status-warning',
  COMPLETED: 'bg-brand-primary-light/40 text-brand-primary',
  CANCELLED: 'bg-status-error-bg text-status-error',
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const te = useTranslations('projectEnums');

  const STATUS_LABELS: Record<ProjectStatus, string> = {
    PLANNING: te('statusPlanning'),
    ACTIVE: te('statusActive'),
    ON_HOLD: te('statusOnHold'),
    COMPLETED: te('statusCompleted'),
    CANCELLED: te('statusCancelled'),
  };

  return (
    <span
      data-testid={`project-status-badge-${status}`}
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? 'bg-surface-border-light text-text-muted'}`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

const PRIORITY_STYLES: Record<ProjectPriority, string> = {
  LOW: 'bg-surface-border-light text-text-muted',
  MEDIUM: 'bg-status-info-bg text-status-info',
  HIGH: 'bg-status-warning-bg text-status-warning',
  URGENT: 'bg-status-error-bg text-status-error',
};

export function ProjectPriorityBadge({ priority }: { priority: ProjectPriority }) {
  const te = useTranslations('projectEnums');

  const PRIORITY_LABELS: Record<ProjectPriority, string> = {
    LOW: te('priorityLow'),
    MEDIUM: te('priorityMedium'),
    HIGH: te('priorityHigh'),
    URGENT: te('priorityUrgent'),
  };

  return (
    <span
      data-testid={`project-priority-badge-${priority}`}
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${PRIORITY_STYLES[priority] ?? 'bg-surface-border-light text-text-muted'}`}
    >
      {PRIORITY_LABELS[priority] ?? priority}
    </span>
  );
}
