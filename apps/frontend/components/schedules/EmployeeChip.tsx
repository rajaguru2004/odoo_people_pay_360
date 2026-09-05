'use client';

import { avatarTint, initialsOf } from './shiftStyles';

/**
 * A person, small enough for a sticky grid column and a sidebar row.
 *
 * The avatar falls back to initials on a hashed tint rather than to a grey
 * silhouette: in a list of forty rows the tint is what the eye actually tracks
 * back to, and forty identical silhouettes are worse than none.
 */
export default function EmployeeChip({
  name,
  code,
  detail,
  avatarUrl,
  size = 'md',
}: {
  name: string;
  code?: string | null;
  /** One line under the code — the department, usually. */
  detail?: string | null;
  avatarUrl?: string | null;
  size?: 'sm' | 'md';
}) {
  const avatar = size === 'sm' ? 'h-8 w-8 text-[10px]' : 'h-9 w-9 text-[11px]';

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          className={`${avatar} shrink-0 rounded-full object-cover`}
        />
      ) : (
        <span
          aria-hidden
          className={`${avatar} flex shrink-0 items-center justify-center rounded-full font-bold text-white`}
          style={{ background: avatarTint(name) }}
        >
          {initialsOf(name)}
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold text-text-heading">
          {name}
        </span>
        {code && (
          <span className="block text-[11px] font-semibold text-text-muted">
            {code}
          </span>
        )}
        {detail && (
          <span className="block truncate text-[10px] font-medium text-text-muted">
            {detail}
          </span>
        )}
      </span>
    </div>
  );
}
