'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import accountingService, {
  JournalEntry,
  LedgerAccount,
  LedgerMapping,
} from '@/services/accountingService';
import { useAuthStore } from '@/store/authStore';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { toast } from '@/lib/toast';
import { apiErrorMessage } from '@/utils/apiError';
import { useConfirm } from '@/hooks/useConfirm';
import { usePageHeader } from '@/hooks/usePageHeader';
import PageActionRow from '@/components/common/PageActionRow';

/**
 * Where loan money lands in the ledger.
 *
 * Gap report §1, the largest hole in the module: there was no accounting
 * anywhere, and `LoanTransaction.journalRef` was declared, indexed and written
 * by nothing — so catalogue §14 was 0% testable because none of it existed.
 *
 * Three tabs, in the order somebody sets this up: name the accounts, say which
 * event posts to which pair, then post. The unmapped-event refusal is shown as
 * a first-class result rather than an error, because "we could not post these
 * six because WRITE_OFF has no mapping" is a work list, not a failure.
 */
const EVENTS = [
  'DISBURSEMENT',
  'EMI_RECOVERY',
  'PREPAYMENT',
  'PROCESSING_FEE',
  'WAIVER',
  'WRITE_OFF',
  'SETTLEMENT',
  'ADJUSTMENT',
  'CONVERSION',
  'TOPUP_SETTLEMENT',
  'REVERSAL',
];

const COMPONENTS = ['TOTAL', 'PRINCIPAL', 'INTEREST', 'FEE'];

type Tab = 'accounts' | 'mappings' | 'journal';

export default function AccountingPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { confirm, ConfirmDialog } = useConfirm();

  const canRead = ['ADMIN', 'HR_MANAGER'].includes(user?.role ?? '');
  const isAdmin = user?.role === 'ADMIN';

  const [tab, setTab] = useState<Tab>('accounts');
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [mappings, setMappings] = useState<LedgerMapping[]>([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [unposted, setUnposted] = useState<
    Array<{ transactionId: string; reason: string }>
  >([]);

  // The one heading for this route, rendered by TopHeader. Declared above the
  // permission early return so the hook runs on every render.
  usePageHeader(
    'Loan ledger',
    'Name the accounts, say which loan event posts to which pair, then post.',
  );

  const [newAccount, setNewAccount] = useState({ code: '', name: '', type: 'ASSET' });
  const [newMapping, setNewMapping] = useState({
    event: 'EMI_RECOVERY',
    component: 'TOTAL',
    debitAccountId: '',
    creditAccountId: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(null);
    try {
      const [a, m, j] = await Promise.all([
        accountingService.accounts(true),
        accountingService.mappings(),
        accountingService.journal(),
      ]);
      const unwrap = (r: any) => (Array.isArray(r) ? r : (r?.data ?? []));
      setAccounts(unwrap(a));
      setMappings(unwrap(m));
      setEntries(unwrap(j));
    } catch (e) {
      // An empty ledger and an unreadable one are different facts about a
      // company's books.
      const reason = apiErrorMessage(e, 'Could not load the ledger');
      setFailed(reason);
      toast.error(reason);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canRead) load();
    else setLoading(false);
  }, [canRead, load]);

  const addAccount = async () => {
    if (!newAccount.code.trim() || !newAccount.name.trim()) {
      toast.warning('An account needs a code and a name');
      return;
    }
    try {
      await accountingService.createAccount(newAccount as Partial<LedgerAccount>);
      toast.success('Account added');
      setNewAccount({ code: '', name: '', type: 'ASSET' });
      await load();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not add this account'));
    }
  };

  const addMapping = async () => {
    if (!newMapping.debitAccountId || !newMapping.creditAccountId) {
      toast.warning('Choose both a debit and a credit account');
      return;
    }
    if (newMapping.debitAccountId === newMapping.creditAccountId) {
      // An entry debiting and crediting one account moves nothing, and hides
      // that it moves nothing.
      toast.warning('The debit and credit sides must be different accounts');
      return;
    }
    try {
      await accountingService.upsertMapping(newMapping);
      toast.success('Mapping saved');
      await load();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not save this mapping'));
    }
  };

  const post = async () => {
    try {
      setPosting(true);
      const res: any = await accountingService.postPending();
      const result = res?.data ?? res;
      setUnposted(result.failures ?? []);
      toast.success(
        `${result.posted} entr${result.posted === 1 ? 'y' : 'ies'} posted` +
          (result.failures?.length
            ? `; ${result.failures.length} could not be mapped`
            : ''),
      );
      await load();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not post to the ledger'));
    } finally {
      setPosting(false);
    }
  };

  const reverse = async (entry: JournalEntry) => {
    const ok = await confirm({
      title: 'Reverse entry',
      message: `Reverse ${entry.reference}? A reversing entry is written; nothing is deleted, and the transaction becomes postable again.`,
      confirmText: 'Reverse',
      type: 'danger',
    });
    if (!ok) return;
    try {
      await accountingService.reverse(entry.id, 'Reversed from the ledger screen');
      toast.success('Entry reversed');
      await load();
    } catch (e) {
      toast.error(apiErrorMessage(e, 'Could not reverse this entry'));
    }
  };

  if (!canRead) {
    return (
      <div className="p-6" data-testid="accounting-forbidden">
        <p className="text-sm font-medium text-text-heading">
          The ledger is an administrator’s view
        </p>
        <p className="mt-1 text-sm text-text-muted">
          These accounts decide how company money is reported, so they are
          limited to HR and administrators.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <ConfirmDialog />

      <PageActionRow
        onBack={() => router.push('/dashboard/advance-loans')}
        action={
          isAdmin ? (
            <button
              data-testid="accounting-post"
              disabled={posting}
              onClick={post}
              className="rounded-lg bg-brand-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {posting ? 'Posting…' : 'Post pending'}
            </button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap gap-2">
        {(['accounts', 'mappings', 'journal'] as Tab[]).map((key) => (
          <button
            key={key}
            data-testid={`accounting-tab-${key}`}
            data-active={String(tab === key)}
            onClick={() => setTab(key)}
            className={`rounded-lg border px-3 py-1.5 text-sm ${
              tab === key
                ? 'border-brand-primary bg-brand-primary-light text-brand-primary'
                : 'border-surface-border hover:bg-surface-page'
            }`}
          >
            {key === 'accounts' ? 'Accounts' : key === 'mappings' ? 'Mappings' : 'Journal'}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-text-muted">Loading…</p>}

      {!loading && failed && (
        <div
          data-testid="accounting-failed"
          className="rounded-lg border border-status-error bg-status-error-bg p-3"
        >
          <p className="text-sm font-medium text-text-heading">
            The ledger could not be loaded
          </p>
          <p className="mt-1 text-sm text-text-muted">{failed}</p>
        </div>
      )}

      {/* What could not be posted, as a work list rather than an error. */}
      {unposted.length > 0 && (
        <div
          data-testid="accounting-unposted"
          data-count={unposted.length}
          className="rounded-lg border border-status-warning bg-status-warning-bg p-3 text-sm"
        >
          <p className="font-medium">
            {unposted.length} transaction(s) could not be posted
          </p>
          <ul className="mt-1 list-inside list-disc text-xs">
            {unposted.slice(0, 5).map((f) => (
              <li key={f.transactionId}>{f.reason}</li>
            ))}
          </ul>
        </div>
      )}

      {!loading && !failed && tab === 'accounts' && (
        <div className="space-y-3">
          {isAdmin && (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="block text-[11px] text-text-muted">Code</label>
                <input
                  data-testid="accounting-account-code"
                  value={newAccount.code}
                  onChange={(e) => setNewAccount({ ...newAccount, code: e.target.value })}
                  className="h-9 w-28 rounded-lg border border-surface-border px-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] text-text-muted">Name</label>
                <input
                  data-testid="accounting-account-name"
                  value={newAccount.name}
                  onChange={(e) => setNewAccount({ ...newAccount, name: e.target.value })}
                  className="h-9 w-64 rounded-lg border border-surface-border px-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] text-text-muted">Type</label>
                <select
                  data-testid="accounting-account-type"
                  value={newAccount.type}
                  onChange={(e) => setNewAccount({ ...newAccount, type: e.target.value })}
                  className="h-9 rounded-lg border border-surface-border px-2 text-sm"
                >
                  {['ASSET', 'LIABILITY', 'INCOME', 'EXPENSE'].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <button
                data-testid="accounting-account-add"
                onClick={addAccount}
                className="h-9 rounded-lg border border-surface-border px-3 text-sm hover:bg-surface-page"
              >
                Add account
              </button>
            </div>
          )}

          {accounts.length === 0 ? (
            <p data-testid="accounting-accounts-empty" className="text-sm text-text-muted">
              No accounts yet. Nothing can be posted until the ledger has some.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-surface-border">
              <table className="w-full text-sm">
                <thead className="bg-surface-page text-xs uppercase text-text-muted">
                  <tr>
                    <th className="px-3 py-2 text-start">Code</th>
                    <th className="px-3 py-2 text-start">Name</th>
                    <th className="px-3 py-2 text-start">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr
                      key={a.id}
                      data-testid="accounting-account-row"
                      data-code={a.code}
                      className="border-t border-surface-border"
                    >
                      <td className="px-3 py-2 font-medium">{a.code}</td>
                      <td className="px-3 py-2">{a.name}</td>
                      <td className="px-3 py-2">{a.type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!loading && !failed && tab === 'mappings' && (
        <div className="space-y-3">
          {isAdmin && (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="block text-[11px] text-text-muted">Event</label>
                <select
                  data-testid="accounting-mapping-event"
                  value={newMapping.event}
                  onChange={(e) => setNewMapping({ ...newMapping, event: e.target.value })}
                  className="h-9 rounded-lg border border-surface-border px-2 text-sm"
                >
                  {EVENTS.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-text-muted">Component</label>
                <select
                  data-testid="accounting-mapping-component"
                  value={newMapping.component}
                  onChange={(e) =>
                    setNewMapping({ ...newMapping, component: e.target.value })
                  }
                  className="h-9 rounded-lg border border-surface-border px-2 text-sm"
                >
                  {COMPONENTS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-text-muted">Debit</label>
                <select
                  data-testid="accounting-mapping-debit"
                  value={newMapping.debitAccountId}
                  onChange={(e) =>
                    setNewMapping({ ...newMapping, debitAccountId: e.target.value })
                  }
                  className="h-9 rounded-lg border border-surface-border px-2 text-sm"
                >
                  <option value="">Choose…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-text-muted">Credit</label>
                <select
                  data-testid="accounting-mapping-credit"
                  value={newMapping.creditAccountId}
                  onChange={(e) =>
                    setNewMapping({ ...newMapping, creditAccountId: e.target.value })
                  }
                  className="h-9 rounded-lg border border-surface-border px-2 text-sm"
                >
                  <option value="">Choose…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                data-testid="accounting-mapping-add"
                onClick={addMapping}
                className="h-9 rounded-lg border border-surface-border px-3 text-sm hover:bg-surface-page"
              >
                Save mapping
              </button>
            </div>
          )}

          {mappings.length === 0 ? (
            <p data-testid="accounting-mappings-empty" className="text-sm text-text-muted">
              Nothing is mapped yet, so nothing will post.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-surface-border">
              <table className="w-full text-sm">
                <thead className="bg-surface-page text-xs uppercase text-text-muted">
                  <tr>
                    <th className="px-3 py-2 text-start">Event</th>
                    <th className="px-3 py-2 text-start">Component</th>
                    <th className="px-3 py-2 text-start">Debit</th>
                    <th className="px-3 py-2 text-start">Credit</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((m) => (
                    <tr
                      key={m.id}
                      data-testid="accounting-mapping-row"
                      data-event={m.event}
                      className="border-t border-surface-border"
                    >
                      <td className="px-3 py-2">{m.event}</td>
                      <td className="px-3 py-2">{m.component}</td>
                      <td className="px-3 py-2">{m.debitAccount?.code}</td>
                      <td className="px-3 py-2">{m.creditAccount?.code}</td>
                      <td className="px-3 py-2 text-end">
                        {isAdmin && (
                          <button
                            data-testid="accounting-mapping-remove"
                            onClick={async () => {
                              try {
                                await accountingService.removeMapping(m.id);
                                toast.success('Mapping removed');
                                await load();
                              } catch (e) {
                                toast.error(
                                  apiErrorMessage(e, 'Could not remove this mapping'),
                                );
                              }
                            }}
                            className="rounded-lg border border-surface-border px-2 py-1 text-xs"
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!loading && !failed && tab === 'journal' && (
        <div className="space-y-2">
          {entries.length === 0 ? (
            <p data-testid="accounting-journal-empty" className="text-sm text-text-muted">
              Nothing has been posted yet.
            </p>
          ) : (
            entries.map((e) => (
              <div
                key={e.id}
                data-testid="accounting-journal-row"
                data-reference={e.reference}
                data-status={e.status}
                className="rounded-lg border border-surface-border p-3"
              >
                <div className="flex flex-wrap items-baseline gap-2 text-sm">
                  <span className="font-medium">{e.reference}</span>
                  <span className="text-text-muted">{formatDate(e.entryDate)}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      e.status === 'POSTED'
                        ? 'bg-status-success-bg text-status-success'
                        : 'bg-surface-page text-text-muted'
                    }`}
                  >
                    {e.status}
                  </span>
                  {isAdmin && e.status === 'POSTED' && (
                    <button
                      data-testid="accounting-journal-reverse"
                      onClick={() => reverse(e)}
                      className="ms-auto rounded-lg border border-surface-border px-2 py-1 text-xs"
                    >
                      Reverse
                    </button>
                  )}
                </div>
                <div className="mt-1 space-y-0.5 text-xs text-text-muted">
                  {e.lines.map((l) => (
                    <div key={l.id} data-testid="accounting-journal-line">
                      {l.component}: {l.debitAccount?.code} → {l.creditAccount?.code} ·{' '}
                      {formatCurrency(Number(l.amount))}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
