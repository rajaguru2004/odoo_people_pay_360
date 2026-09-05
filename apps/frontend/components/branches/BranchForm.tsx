'use client';
import { getApiErrorMessage } from '@/lib/apiError';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Building2,
  MapPin,
  Clock,
  Navigation,
  X,
  AlertCircle,
  CheckCircle2,
  Info,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';
import { useBranch, useCreateBranch, useUpdateBranch } from '@/hooks/useBranches';
import { COUNTRIES } from '@/lib/countries';

function buildBranchSchema(t: (key: string) => string) {
  const rangedNumber = (min: number, max: number, msg: string) =>
    z
      .string()
      .optional()
      .refine(
        (v) => !v || v.trim() === '' || (!Number.isNaN(Number(v)) && Number(v) >= min && Number(v) <= max),
        { message: msg },
      );

  return z.object({
    code: z.string().min(1, t('zodCodeRequired')).max(50, t('zodCodeMax')),
    name: z.string().min(1, t('zodNameRequired')).max(255, t('zodNameMax')),
    description: z.string().optional(),
    isActive: z.boolean().optional(),
    addressLine: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    country: z.string().optional(),
    postalCode: z.string().optional(),
    timezone: z.string().optional(),
    officeStartTime: z.string().optional(),
    officeEndTime: z.string().optional(),
    weeklyOffDays: z.string().optional(),
    geofencingEnabled: z.boolean().optional(),
    latitude: rangedNumber(-90, 90, t('zodLatRange')),
    longitude: rangedNumber(-180, 180, t('zodLngRange')),
    geofenceRadiusM: z
      .string()
      .optional()
      .refine((v) => !v || v.trim() === '' || (!Number.isNaN(Number(v)) && Number(v) > 0), {
        message: t('zodRadiusPositive'),
      }),
  });
}

type BranchFormData = z.infer<ReturnType<typeof buildBranchSchema>>;

interface BranchFormProps {
  mode: 'create' | 'edit';
  branchId?: string;
}

const baseInput =
  'w-full px-4 py-3.5 border-2 rounded-[--radius-input] font-medium transition-all text-text-body';

const WEEK_DAYS = [
  { value: '0', label: 'Sun' },
  { value: '1', label: 'Mon' },
  { value: '2', label: 'Tue' },
  { value: '3', label: 'Wed' },
  { value: '4', label: 'Thu' },
  { value: '5', label: 'Fri' },
  { value: '6', label: 'Sat' },
];

const fieldClass = (hasError?: boolean) =>
  `${baseInput} ${
    hasError
      ? 'border-status-error bg-status-error-bg/35 focus:border-status-error focus:ring-4 focus:ring-status-error/20 bg-surface-card'
      : 'border-surface-border bg-surface-card hover:border-surface-border/85 focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/20'
  }`;

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-2 text-status-error text-sm font-medium"
    >
      <AlertCircle size={14} />
      <span>{message}</span>
    </motion.div>
  );
}

export default function BranchForm({ mode, branchId }: BranchFormProps) {
  const router = useRouter();
  const t = useTranslations('branchForm');
  const tc = useTranslations('common');

  // Both /new and /[id]/edit route through this form, so the heading is
  // mode-conditional. TopHeader renders it; the form must not repeat it.
  usePageHeader(
    mode === 'create' ? t('createHeading') : t('editHeading'),
    mode === 'create' ? t('createSubtitle') : t('editSubtitle'),
  );

  const { data: branchResp, isLoading: loadingBranch, isError } = useBranch(
    mode === 'edit' ? branchId || '' : '',
  );
  const createBranch = useCreateBranch();
  const updateBranch = useUpdateBranch();
  const loading = createBranch.isPending || updateBranch.isPending;

  const {
    register,
    handleSubmit,
    watch,
    reset,
    setValue,
    formState: { errors },
  } = useForm<BranchFormData>({
    resolver: async (values, context, options) =>
      zodResolver(buildBranchSchema(t))(values, context, options),
    defaultValues: {
      isActive: true,
      geofencingEnabled: false,
    },
  });

  const geofencingEnabled = watch('geofencingEnabled');

  // Prefill in edit mode once the branch has loaded.
  useEffect(() => {
    if (mode === 'edit' && branchResp?.data) {
      const b = branchResp.data;
      reset({
        code: b.code,
        name: b.name,
        description: b.description || '',
        isActive: b.isActive,
        addressLine: b.addressLine || '',
        city: b.city || '',
        state: b.state || '',
        country: b.country || '',
        postalCode: b.postalCode || '',
        timezone: b.timezone || '',
        officeStartTime: b.officeStartTime || '',
        officeEndTime: b.officeEndTime || '',
        weeklyOffDays: b.weeklyOffDays || '',
        geofencingEnabled: !!b.geofencingEnabled,
        latitude: b.latitude != null ? String(b.latitude) : '',
        longitude: b.longitude != null ? String(b.longitude) : '',
        geofenceRadiusM: b.geofenceRadiusM != null ? String(b.geofenceRadiusM) : '',
      });
    }
  }, [mode, branchResp, reset]);

  // Bounce back to the list if the branch could not be loaded.
  useEffect(() => {
    if (mode === 'edit' && isError) {
      alert(t('noBranchFound'));
      router.push('/dashboard/branches');
    }
  }, [mode, isError, router, t]);

  const onSubmit = async (data: BranchFormData) => {
    const toNum = (v?: string) => (v && v.trim() !== '' ? Number(v) : undefined);
    const trimOrUndef = (v?: string) => (v && v.trim() !== '' ? v.trim() : undefined);

    // Blank config fields are omitted so the backend keeps the global default.
    const payload = {
      code: data.code.trim(),
      name: data.name.trim(),
      description: trimOrUndef(data.description),
      addressLine: trimOrUndef(data.addressLine),
      city: trimOrUndef(data.city),
      state: trimOrUndef(data.state),
      country: trimOrUndef(data.country),
      postalCode: trimOrUndef(data.postalCode),
      timezone: trimOrUndef(data.timezone),
      officeStartTime: trimOrUndef(data.officeStartTime),
      officeEndTime: trimOrUndef(data.officeEndTime),
      // Empty selection => null so the branch reverts to the company default
      // (an empty string would be read as a real "zero weekly-off days" week).
      weeklyOffDays:
        data.weeklyOffDays && data.weeklyOffDays.trim() !== ''
          ? data.weeklyOffDays.trim()
          : null,
      geofencingEnabled: !!data.geofencingEnabled,
      latitude: toNum(data.latitude),
      longitude: toNum(data.longitude),
      geofenceRadiusM: toNum(data.geofenceRadiusM),
    };

    try {
      if (mode === 'create') {
        await createBranch.mutateAsync(payload);
        alert(t('createSuccess'));
      } else if (branchId) {
        await updateBranch.mutateAsync({
          id: branchId,
          data: { ...payload, isActive: !!data.isActive },
        });
        alert(t('updateSuccess'));
      }
      router.push('/dashboard/branches');
    } catch (error: any) {
      alert(getApiErrorMessage(error, t('saveFailed')));
    }
  };

  if (mode === 'edit' && loadingBranch) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 bg-slate-200 rounded w-64">{/* neutral */}</div>
        <div className="bg-surface-card rounded-[--radius-card] p-8 space-y-6">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-12 bg-slate-100 rounded">{/* neutral */}</div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* The heading itself is declared to TopHeader above; only the back
          affordance belongs on the page. */}
      <PageActionRow
        onBack={() => router.back()}
      />

      {/* Form */}
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="bg-surface-card rounded-[--radius-card] border-2 border-surface-border shadow-xl overflow-hidden"
      >
        <div className="p-8 space-y-8">
          {/* Section 1: Basic Info */}
          <div className="space-y-6">
            <div className="flex items-center gap-3 pb-4 border-b-2 border-surface-border">
              <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-r from-brand-primary to-brand-primary-dark flex items-center justify-center shadow-lg">
                <Building2 className="text-text-on-brand" size={24} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-text-heading">{t('basicInfoHeading')}</h2>
                <p className="text-sm text-text-muted">{t('basicInfoDesc')}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Code */}
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">
                  {t('codeLabel')} <span className="text-status-error">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    data-testid="branch-code" {...register('code')}
                    placeholder={t('codePlaceholder')}
                    className={`${fieldClass(!!errors.code)} ps-11`}
                  />
                  <div className="absolute start-4 top-1/2 -translate-y-1/2">
                    <Building2 size={16} className={errors.code ? 'text-status-error' : 'text-text-muted'} />
                  </div>
                </div>
                <FieldError message={errors.code?.message} />
                <p className="text-xs text-text-muted">{t('codeHelper')}</p>
              </div>

              {/* Name */}
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">
                  {t('nameLabel')} <span className="text-status-error">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    data-testid="branch-name" {...register('name')}
                    placeholder={t('namePlaceholder')}
                    className={`${fieldClass(!!errors.name)} ps-11`}
                  />
                  <div className="absolute start-4 top-1/2 -translate-y-1/2">
                    <Building2 size={16} className={errors.name ? 'text-status-error' : 'text-text-muted'} />
                  </div>
                </div>
                <FieldError message={errors.name?.message} />
                <p className="text-xs text-text-muted">{t('nameHelper')}</p>
              </div>
            </div>

            {/* Description */}
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-text-body">{tc('description')}</label>
              <textarea
                data-testid="branch-description" {...register('description')}
                rows={3}
                placeholder={t('descriptionPlaceholder')}
                className="w-full px-4 py-3.5 border-2 border-surface-border rounded-[--radius-input] font-medium bg-surface-card hover:border-surface-border/85 focus:border-brand-primary focus:ring-4 focus:ring-brand-primary/20 transition-all resize-none text-text-body"
              />
              <p className="text-xs text-text-muted">{t('descriptionHelper')}</p>
            </div>

            {/* Active toggle (edit only) */}
            {mode === 'edit' && (
              <label className="flex items-center gap-3 p-4 bg-surface-page rounded-[--radius-card] border-2 border-surface-border cursor-pointer">
                <input
                  type="checkbox"
                  data-testid="branch-active" {...register('isActive')}
                  className="w-5 h-5 rounded accent-brand-primary cursor-pointer"
                />
                <div>
                  <span className="text-sm font-semibold text-text-body">{t('activeLabel')}</span>
                  <p className="text-xs text-text-muted">{t('activeHelper')}</p>
                </div>
              </label>
            )}
          </div>

          {/* Section 2: Address */}
          <div className="space-y-6">
            <div className="flex items-center gap-3 pb-4 border-b-2 border-surface-border">
              <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-r from-brand-accent to-brand-accent-dark flex items-center justify-center shadow-lg">
                <MapPin className="text-text-on-accent" size={24} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-text-heading">{t('addressHeading')}</h2>
                <p className="text-sm text-text-muted">{t('addressDesc')}</p>
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-semibold text-text-body">{t('addressLineLabel')}</label>
              <input
                type="text"
                data-testid="branch-address" {...register('addressLine')}
                placeholder={t('addressLinePlaceholder')}
                className={fieldClass(false)}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">{t('cityLabel')}</label>
                <input
                  type="text"
                  data-testid="branch-city" {...register('city')}
                  placeholder={t('cityPlaceholder')}
                  className={fieldClass(false)}
                />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">{t('stateLabel')}</label>
                <input
                  type="text"
                  data-testid="branch-state" {...register('state')}
                  placeholder={t('statePlaceholder')}
                  className={fieldClass(false)}
                />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">{t('countryLabel')}</label>
                <select data-testid="branch-country" {...register('country')} className={fieldClass(false)}>
                  <option value="">{t('countryPlaceholder')}</option>
                  {/* Preserve a legacy free-text value so editing doesn't wipe it. */}
                  {watch('country') &&
                    !COUNTRIES.some((c) => c.code === watch('country')) && (
                      <option value={watch('country')}>{watch('country')} (legacy)</option>
                    )}
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-text-muted">
                  Drives the banking fields employees at this branch must fill.
                </p>
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">{t('postalCodeLabel')}</label>
                <input
                  type="text"
                  data-testid="branch-postal" {...register('postalCode')}
                  placeholder={t('postalCodePlaceholder')}
                  className={fieldClass(false)}
                />
              </div>
            </div>
          </div>

          {/* Section 3: Work configuration */}
          <div className="space-y-6">
            <div className="flex items-center gap-3 pb-4 border-b-2 border-surface-border">
              <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-r from-brand-primary to-brand-primary-dark flex items-center justify-center shadow-lg">
                <Clock className="text-text-on-brand" size={24} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-text-heading">{t('workConfigHeading')}</h2>
                <p className="text-sm text-text-muted">{t('workConfigDesc')}</p>
              </div>
            </div>

            {/* Inherit-global helper note */}
            <div className="flex items-start gap-2 p-3 bg-brand-primary-light/10 border border-brand-primary/20 rounded-[--radius-card]">
              <Info size={16} className="text-brand-primary mt-0.5 shrink-0" />
              <p className="text-xs text-brand-primary font-medium">{t('inheritNote')}</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">{t('timezoneLabel')}</label>
                <input
                  type="text"
                  data-testid="branch-timezone" {...register('timezone')}
                  placeholder={t('timezonePlaceholder')}
                  className={fieldClass(false)}
                />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">{t('officeStartLabel')}</label>
                <input data-testid="branch-start-time" type="time" {...register('officeStartTime')} className={fieldClass(false)} />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">{t('officeEndLabel')}</label>
                <input data-testid="branch-end-time" type="time" {...register('officeEndTime')} className={fieldClass(false)} />
              </div>
            </div>

            {/* Weekly off days */}
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-text-body">
                Weekly Off Days
              </label>
              <p className="text-xs text-text-muted">
                Days this branch does not work (e.g. Fri &amp; Sat for a Gulf
                branch). Leave all unselected to inherit the company default.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                {WEEK_DAYS.map((d) => {
                  const current = (watch('weeklyOffDays') || '')
                    .split(',')
                    .filter(Boolean);
                  const selected = current.includes(d.value);
                  return (
                    <button
                      key={d.value}
                      type="button"
                      data-testid={`branch-weekoff-${d.value}`}
                      onClick={() => {
                        const next = selected
                          ? current.filter((x) => x !== d.value)
                          : [...current, d.value];
                        setValue('weeklyOffDays', next.sort().join(','), {
                          shouldDirty: true,
                        });
                      }}
                      className={`px-3.5 py-2 text-xs rounded-[--radius-button] border-2 font-semibold transition-all ${
                        selected
                          ? 'border-brand-primary bg-brand-primary/10 text-brand-primary'
                          : 'border-surface-border bg-surface-card text-text-muted hover:border-brand-primary/40'
                      }`}
                    >
                      {d.label}
                    </button>
                  );
                })}
              </div>
              {/* Spell out the consequence of the selection. Every day named
                  here is a REST DAY, and overtime on a rest day pays at the
                  double multiplier — a branch saved with Mon–Sat selected once
                  repriced a whole week of weekday overtime at 2x before anyone
                  noticed. Showing the working days back is what makes an
                  inverted selection (working days entered as off days) obvious
                  while it is still on screen. */}
              {(() => {
                const off = (watch('weeklyOffDays') || '')
                  .split(',')
                  .filter(Boolean);
                if (off.length === 0) return null;
                const working = WEEK_DAYS.filter((d) => !off.includes(d.value));
                return (
                  <p
                    data-testid="branch-weekoff-summary"
                    className={`text-xs pt-1 ${
                      off.length >= 5
                        ? 'text-status-warning font-semibold'
                        : 'text-text-muted'
                    }`}
                  >
                    Working days: {working.map((d) => d.label).join(', ') || 'none'}.
                    {off.length >= 5
                      ? ` All overtime on the ${off.length} selected days is paid at rest-day (double) rates — check you have not selected working days by mistake.`
                      : ''}
                  </p>
                );
              })()}
            </div>
          </div>

          {/* Section 4: Geofence */}
          <div className="space-y-6">
            <div className="flex items-center gap-3 pb-4 border-b-2 border-surface-border">
              <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-r from-brand-accent to-brand-accent-dark flex items-center justify-center shadow-lg">
                <Navigation className="text-text-on-accent" size={24} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-text-heading">{t('geofenceHeading')}</h2>
                <p className="text-sm text-text-muted">{t('geofenceDesc')}</p>
              </div>
            </div>

            <label className="flex items-center gap-3 p-4 bg-surface-page rounded-[--radius-card] border-2 border-surface-border cursor-pointer">
              <input
                type="checkbox"
                data-testid="branch-geofencing" {...register('geofencingEnabled')}
                className="w-5 h-5 rounded accent-brand-accent cursor-pointer"
              />
              <div>
                <span className="text-sm font-semibold text-text-body">{t('geofenceEnabledLabel')}</span>
                <p className="text-xs text-text-muted">{t('geofenceEnabledHelper')}</p>
              </div>
            </label>

            <div
              className={`grid grid-cols-1 md:grid-cols-3 gap-6 transition-opacity ${
                geofencingEnabled ? 'opacity-100' : 'opacity-60'
              }`}
            >
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">{t('latitudeLabel')}</label>
                <input
                  type="text"
                  inputMode="decimal"
                  data-testid="branch-latitude" {...register('latitude')}
                  placeholder={t('latitudePlaceholder')}
                  className={fieldClass(!!errors.latitude)}
                />
                <FieldError message={errors.latitude?.message} />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">{t('longitudeLabel')}</label>
                <input
                  type="text"
                  inputMode="decimal"
                  data-testid="branch-longitude" {...register('longitude')}
                  placeholder={t('longitudePlaceholder')}
                  className={fieldClass(!!errors.longitude)}
                />
                <FieldError message={errors.longitude?.message} />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-text-body">{t('radiusLabel')}</label>
                <input
                  type="text"
                  inputMode="numeric"
                  data-testid="branch-radius" {...register('geofenceRadiusM')}
                  placeholder={t('radiusPlaceholder')}
                  className={fieldClass(!!errors.geofenceRadiusM)}
                />
                <FieldError message={errors.geofenceRadiusM?.message} />
              </div>
            </div>
          </div>
        </div>

        {/* Actions Footer */}
        <div className="px-8 py-6 bg-surface-page border-t-2 border-surface-border flex items-center justify-between">
          <button
            type="button"
            data-testid="branch-cancel"
            onClick={() => router.back()}
            className="group flex items-center gap-2 px-7 py-3.5 border-2 border-surface-border text-text-body rounded-[--radius-button] hover:bg-surface-card hover:border-surface-border-light hover:shadow-lg transition-all font-bold bg-surface-card"
          >
            <X size={20} className="group-hover:rotate-90 transition-transform" />
            <span>{tc('cancel')}</span>
          </button>
          <button
            type="submit"
            data-testid="branch-submit"
            disabled={loading}
            className="group flex items-center gap-3 px-10 py-3.5 bg-gradient-to-r from-brand-primary to-brand-primary-dark text-text-on-brand rounded-[--radius-button] hover:shadow-2xl hover:scale-105 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 font-bold shadow-xl cursor-pointer"
          >
            {loading ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <span>{t('savingBtn')}</span>
              </>
            ) : (
              <>
                <CheckCircle2 size={20} className="group-hover:scale-110 transition-transform" />
                <span>{mode === 'create' ? t('createBtn') : t('saveChangesBtn')}</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
