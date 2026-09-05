'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from '@/lib/toast';
import { Save, X, Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';
import employeeService from '@/services/employeeService';
import { employeeProfileService } from '@/services/employeeProfileService';
import departmentService from '@/services/departmentService';
import branchService from '@/services/branchService';
import libraryService, { LibraryItem } from '@/services/libraryService';
import contractService from '@/services/contractService';
import overtimePolicyService, { OvertimePolicy } from '@/services/overtimePolicyService';
import { Department } from '@/types/department';
import { departmentPickerOptions } from '@/lib/departmentOptions';
import { useConfirm } from '@/hooks/useConfirm';
import { useStartDateBounds } from '@/hooks/useStartDateBounds';
import TimezoneSelect from '@/components/common/TimezoneSelect';
import { formatCurrency } from '@/utils/formatters';
import { getApiErrorMessage } from '@/lib/apiError';
import { applyServerErrors } from '@/lib/applyServerErrors';
import { useProfileTemplate } from '@/hooks/useProfileTemplate';
import { TemplateFormRenderer } from '@/components/dynamic-form/TemplateFormRenderer';
import {
    buildTemplateSchema,
    toEmployeePayloads,
    toFormDefaults,
} from '@/components/dynamic-form/buildTemplateSchema';
import { FieldOptionSources } from '@/components/dynamic-form/Field';
import { TemplateField, TemplateSection } from '@/types/profile-template';
import { payBasisForEmploymentType, payBasisLabel, toSalaryBasis } from '@/utils/payBasis';
import SalaryStructure from '@/components/employees/SalaryStructure';

/**
 * Employee create/edit form.
 *
 * The fields, their labels, order, sections and requiredness come from the
 * active Employee Profile Template — this file no longer knows what an employee
 * has. What it does keep is the behaviour a generic renderer cannot know:
 *
 *   - pay basis is DERIVED from the employment type and must be locked when a
 *     library item dictates it (getting this wrong re-reads a per-day rate as a
 *     monthly salary);
 *   - employee code and ID card are regenerated when the department changes;
 *   - the optional initial-contract block, which is a different entity.
 *
 * The two divergent hand-written zod schemas this replaced had already drifted
 * from each other; both halves now derive from one template.
 */

/** The contract block is a separate entity, so it keeps its own schema. */
const contractSchema = z
    .object({
        enabled: z.boolean().default(false),
        contractType: z.enum(['PROBATION', 'FIXED_TERM', 'INDEFINITE']).optional(),
        workType: z.enum(['FULL_TIME', 'PART_TIME']).optional(),
        workHoursPerWeek: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional().nullable(),
        notes: z.string().optional(),
    })
    .optional();

interface EmployeeFormProps {
    employeeId?: string;
    mode: 'create' | 'edit';
}

/**
 * Filled by the server from the department; the form only previews them.
 *
 * Kept separate from the read-only list, which also carries `salaryType` when
 * an employment type locks it — that one is read-only because it is DERIVED
 * FROM ANOTHER ANSWER, not because the system generates it, and it is not
 * required, so conflating the two would quietly drop a rule that should stay.
 */
const DERIVED_FIELD_KEYS = ['employeeCode', 'idCard'];

export default function EmployeeForm({ employeeId, mode }: EmployeeFormProps) {
    const router = useRouter();
    const t = useTranslations('employeeForm');
    const tc = useTranslations('common');
    // Shared pay-basis strings, consumed by utils/payBasis.ts helpers.
    const tp = useTranslations('payBasis');

    // Both /new and /[id]/edit route through this form, so the heading is
    // mode-conditional. TopHeader renders it; the form must not repeat it.
    usePageHeader(
        mode === 'create' ? t('addHeading') : t('editHeading'),
        mode === 'create' ? t('addSubtitle') : t('editSubtitle'),
    );

    const [departments, setDepartments] = useState<Department[]>([]);
    const [branches, setBranches] = useState<any[]>([]);
    const [positions, setPositions] = useState<LibraryItem[]>([]);
    const [otPolicies, setOtPolicies] = useState<OvertimePolicy[]>([]);
    const [supervisors, setSupervisors] = useState<any[]>([]);
    // Full library items, not just labels: an EMPLOYMENT_TYPE item carries the
    // payBasis that decides (and locks) this employee's Pay Basis.
    const [employmentTypes, setEmploymentTypes] = useState<LibraryItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadingData, setLoadingData] = useState(mode === 'edit');
    const { confirm, ConfirmDialog, closeModal, setLoading: setConfirmLoading } = useConfirm();
    // Picker hints only — the server holds the real policy.
    const startDateBounds = useStartDateBounds();
    // Prevents re-generating the employee code on initial form population (reset)
    const skipNextDeptEffect = useRef(false);
    // Same idea for pay basis: fetchEmployee's reset() sets employmentType and
    // salaryType together while the library fetch may still be in flight, so
    // without this guard merely OPENING an existing employee would rewrite their
    // stored pay basis — which re-reads their base salary.
    const skipNextBasisEffect = useRef(mode === 'edit');

    const { data: template, isLoading: templateLoading } = useProfileTemplate({
        mode: mode === 'create' ? 'CREATE' : 'EDIT',
        employeeId,
    });

    const templateFields = useMemo<TemplateField[]>(
        () => template?.fields ?? [],
        [template],
    );

    const schema = useMemo(() => {
        const base = buildTemplateSchema(templateFields, {
            // Generated from the department and rendered read-only, so the
            // user cannot satisfy a required error on them.
            derivedFields: DERIVED_FIELD_KEYS,
        });
        return (base as z.ZodObject<any>).extend({ initialContract: contractSchema });
    }, [templateFields]);

    const form = useForm<any>({
        resolver: zodResolver(schema as any) as any,
        defaultValues: {
            status: 'ACTIVE',
            salaryType: 'MONTHLY',
            employmentType: '',
            customFields: {},
            initialContract: { enabled: false, workType: 'FULL_TIME' },
        },
    });
    const {
        register,
        handleSubmit,
        formState: { errors },
        reset,
        watch,
        setValue,
        setError,
    } = form;

    // ── Employment Type -> Pay Basis ────────────────────────────────────────
    // A library item flagged MONTHLY/DAILY dictates this employee's pay basis;
    // an unflagged one leaves the choice to HR. The server derives the same
    // thing on save, so the UI is only mirroring the rule, never inventing it.
    const watchedEmploymentType = watch('employmentType');
    const watchedSalaryType = watch('salaryType');
    const lockedBasis = payBasisForEmploymentType(employmentTypes, watchedEmploymentType);
    // In edit mode, surface a pending change instead of silently rewriting a
    // live employee's basis on page load.
    const basisWillChange =
        mode === 'edit' && !!lockedBasis && lockedBasis !== watchedSalaryType;

    useEffect(() => {
        if (!lockedBasis) return;
        if (skipNextBasisEffect.current) {
            skipNextBasisEffect.current = false;
            return;
        }
        if (lockedBasis !== watchedSalaryType) {
            setValue('salaryType', lockedBasis, { shouldValidate: true, shouldDirty: true });
        }
        // watchedSalaryType is deliberately absent: reacting to it would fight
        // the user on every manual change while no basis is locked.
         
    }, [lockedBasis]);

    useEffect(() => {
        departmentService
            .getAll()
            .then((r) => setDepartments(r.data))
            .catch(() => undefined);
        branchService
            .getAll()
            .then((r) => setBranches(r.data || []))
            .catch(() => undefined);
        libraryService
            .getAll('POSITION', true)
            .then((r) => setPositions(r.data || []))
            .catch(() => undefined);
        libraryService
            .getAll('EMPLOYMENT_TYPE', true)
            .then((r) => setEmploymentTypes(r.data || []))
            .catch(() => undefined);
        overtimePolicyService
            .list()
            .then((r) => setOtPolicies(r.data || []))
            .catch(() => undefined);
        employeeService
            .getAll({ limit: 500 })
            .then((r: any) => setSupervisors(r?.data || []))
            .catch(() => undefined);
        if (mode === 'edit' && employeeId) fetchEmployee();
    }, [mode, employeeId]);

    const watchedDepartmentId = watch('departmentId');
    const contractEnabled = watch('initialContract.enabled');
    const watchedContractType = watch('initialContract.contractType');
    const watchedWorkType = watch('initialContract.workType');
    const prevContractEnabled = useRef(false);

    // When contract section is toggled on, pre-fill contract startDate from employment startDate
    useEffect(() => {
        if (contractEnabled && !prevContractEnabled.current) {
            const empStartDate = watch('startDate');
            if (empStartDate) setValue('initialContract.startDate', empStartDate);
        }
        prevContractEnabled.current = !!contractEnabled;
    }, [contractEnabled]);

    useEffect(() => {
        // Skip the effect triggered by the initial reset() call in fetchEmployee
        if (skipNextDeptEffect.current) {
            skipNextDeptEffect.current = false;
            return;
        }

        if (watchedDepartmentId && mode === 'create') {
            // Regenerate employee code & ID card on CREATE only.
            //
            // This used to run on edit too, and the result was two identifiers
            // that disagreed: the effect rewrote both, `onSubmit` then deletes
            // `employeeCode` from the PATCH (the server owns it), and
            // `EmployeesService.update` never regenerates it — so the employee
            // ended up with an idCard carrying the NEW department's prefix and
            // an employeeCode still carrying the old one.
            //
            // Not regenerating is also the right answer on its own terms: an ID
            // card is a physical artefact already in someone's wallet, and
            // moving them between departments is no reason to reissue it.
            employeeService
                .generateCode(watchedDepartmentId)
                .then((response) => {
                    if (response?.success && response?.data?.employeeCode) {
                        setValue('employeeCode', response.data.employeeCode, { shouldValidate: true });
                        setValue('idCard', response.data.employeeCode, { shouldValidate: true });
                    }
                })
                .catch((error) => console.error('Failed to generate employee code:', error));
        } else if (mode === 'create') {
            // Only clear the codes in create mode when no department is selected
            setValue('employeeCode', '');
            setValue('idCard', '');
        }
    }, [mode, watchedDepartmentId, setValue]);

    const fetchEmployee = async () => {
        if (!employeeId) return;
        try {
            setLoadingData(true);
            const response = await employeeService.getById(employeeId);
            const employee: any = response.data;

            // Suppress the dept-change effect that fires when reset() sets departmentId
            skipNextDeptEffect.current = true;
            reset({
                // Nulls become the empty value each control wants, driven by
                // the template rather than the hand-kept `|| ''` list below —
                // that list only ever covered the fields someone remembered.
                ...toFormDefaults(employee, templateFields),
                // Dates arrive as ISO timestamps; <input type="date"> needs Y-M-D.
                dateOfBirth: employee.dateOfBirth?.split('T')[0] ?? '',
                startDate: employee.startDate?.split('T')[0] ?? '',
                endDate: employee.endDate?.split('T')[0] ?? '',
                baseSalary: employee.baseSalary != null ? Number(employee.baseSalary) : undefined,
                salaryType: toSalaryBasis(employee.salaryType),
                timezone: employee.timezone || '',
                employmentType: employee.employmentType || '',
                overtimePolicyId: employee.overtimePolicyId || '',
                supervisorId: employee.supervisorId || '',
                // The API omits fields this role may not see, so `?? {}` keeps
                // the form model consistent rather than leaving it undefined.
                customFields: employee.customFields ?? {},
                ...(employee.profile ?? {}),
                initialContract: { enabled: false, workType: 'FULL_TIME' },
            });
        } catch (error) {
            console.error('Failed to fetch employee:', error);
            toast.error(t('loadFailed'));
            router.back();
        } finally {
            setLoadingData(false);
        }
    };

    const optionSources: FieldOptionSources = useMemo(
        () => ({
            DEPARTMENT: departmentPickerOptions(departments),
            BRANCH: branches.map((b: any) => ({
                value: b.id,
                label: b.code ? `${b.name} (${b.code})` : b.name,
            })),
            EMPLOYEE: supervisors
                .filter((e: any) => e.id !== employeeId)
                .map((e: any) => ({ value: e.id, label: `${e.fullName} (${e.employeeCode})` })),
            POSITION: positions.map((p) => ({ value: p.label, label: p.label })),
            EMPLOYMENT_TYPE: employmentTypes.map((e) => ({ value: e.label, label: e.label })),
            // Keyed by fieldKey: a one-off select with no shared source.
            overtimePolicyId: otPolicies.map((p) => ({
                value: p.id,
                label: p.isDefault ? `${p.name} (default)` : p.name,
            })),
        }),
        [departments, branches, supervisors, positions, employmentTypes, otPolicies, employeeId],
    );

    // Server-owned or derived values the user must not type over.
    const readOnlyFields = useMemo(() => {
        const ro = ['employeeCode', 'idCard'];
        if (lockedBasis) ro.push('salaryType');
        return ro;
    }, [lockedBasis]);

    /**
     * Overrides for the two fields a plain template control cannot express.
     *
     * `startDate` carries min/max from the employment start-date policy. Those
     * are picker HINTS — the server holds the real policy and rejects anything
     * outside it — but without them the calendar silently offers dates the save
     * will refuse. main added these to the hand-written input this form
     * replaced, so they are re-applied here rather than lost to the rewrite.
     */
    const renderField = (field: TemplateField) => {
        if (field.fieldKey === 'startDate') {
            return (
                <>
                    <label className="block text-sm font-medium text-text-heading mb-2">
                        {field.label}
                        {field.required && <span className="text-status-error"> *</span>}
                    </label>
                    <input
                        type="date"
                        {...register('startDate')}
                        min={startDateBounds.min}
                        max={startDateBounds.max}
                        className={`w-full px-4 py-2 border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body ${
                            errors.startDate ? 'border-status-error' : 'border-surface-border'
                        }`}
                    />
                    <p className="mt-1 text-xs text-text-secondary">{t('startDateHint')}</p>
                </>
            );
        }

        /** The timezone picker is a grouped searchable widget, not a plain select. */
        if (field.fieldKey !== 'timezone') return undefined;
        return (
            <>
                <label className="block text-sm font-medium text-text-heading mb-2">
                    {field.label}
                </label>
                <TimezoneSelect
                    value={watch('timezone') || ''}
                    onChange={(v: string) => setValue('timezone', v, { shouldDirty: true })}
                />
                {field.helpText && (
                    <p className="mt-1 text-xs text-text-muted">{field.helpText}</p>
                )}
            </>
        );
    };

    /**
     * The salary BREAKUP, under the Compensation fields.
     *
     * Base Salary alone was the only pay figure this form has ever shown, so an
     * employee's HRA / DA / housing lines — which the payroll engine already
     * reads and pays — were invisible and uneditable here. They lived on a tab
     * of the detail page that nobody editing compensation would think to open.
     *
     * A separate entity, so it stays outside the template payload and saves
     * itself; the section footer is the hook the renderer already provides for
     * exactly this.
     */
    const renderSectionFooter = (section: TemplateSection) => {
        if (section.sectionKey !== 'compensation') return null;
        if (mode !== 'edit' || !employeeId) return null;
        return (
            <div className="mt-6 rounded-[--radius-card] border border-surface-border bg-surface-page p-5">
                <h3 className="text-sm font-semibold text-text-heading mb-1">
                    {t('salaryBreakupHeading')}
                </h3>
                <SalaryStructure
                    employeeId={employeeId}
                    canEdit
                    salaryType={toSalaryBasis(watchedSalaryType)}
                    baseSalary={watch('baseSalary')}
                    embedded
                />
            </div>
        );
    };

    /**
     * Persist the EmployeeProfile half of the form.
     *
     * A second call rather than a second field on the employee DTO: the columns
     * live on a different table behind `PATCH /employees/:id/profile`, and the
     * employee endpoints reject them. Failing here does not undo the employee
     * save, so it reports itself rather than pretending the whole thing failed.
     */
    const saveProfileValues = async (
        id: string | undefined,
        profileValues: Record<string, unknown>,
    ) => {
        if (!id || !Object.keys(profileValues).length) return;
        try {
            await employeeProfileService.updateProfile(id, profileValues);
        } catch (error: unknown) {
            toast.error(
                t('profileSaveFailed', {
                    error: getApiErrorMessage(error, t('genericError')),
                }),
            );
        }
    };

    const onSubmit = async (data: any) => {
        // Manual validation for the optional contract section
        if (data.initialContract?.enabled) {
            let hasContractError = false;
            const c = data.initialContract;
            if (!c.contractType) {
                setError('initialContract.contractType' as any, { message: t('contractTypeRequired') });
                hasContractError = true;
            }
            if (!c.startDate) {
                setError('initialContract.startDate' as any, { message: t('contractStartDateRequired') });
                hasContractError = true;
            }
            if (c.contractType && c.contractType !== 'INDEFINITE' && !c.endDate) {
                setError('initialContract.endDate' as any, { message: t('contractEndDateRequired') });
                hasContractError = true;
            }
            if (c.workType === 'PART_TIME' && (!c.workHoursPerWeek || parseInt(c.workHoursPerWeek) < 1)) {
                setError('initialContract.workHoursPerWeek' as any, { message: t('hoursPerWeekRequired') });
                hasContractError = true;
            }
            if (hasContractError) return;
        }

        const confirmed = await confirm({
            title: mode === 'create' ? t('confirmCreateTitle') : t('confirmUpdateTitle'),
            message:
                mode === 'create'
                    ? t('confirmCreateDesc', { name: data.fullName })
                    : t('confirmUpdateDesc', { name: data.fullName }),
            confirmText: mode === 'create' ? t('createNewBtn') : t('updateBtn'),
            type: 'info',
        });
        if (!confirmed) return;

        // Only fields the template governs are sent, split by the table they
        // belong to: the employee endpoints run under `forbidNonWhitelisted`, so
        // an untouched form model (which after an edit still holds `id`,
        // `createdAt` and the nested relations `reset()` put there) is rejected
        // outright, and EmployeeProfile columns have their own endpoint.
        const { initialContract, ...formValues } = data;
        const { employee: governed, profile: profileValues } = toEmployeePayloads(
            formValues,
            templateFields,
            // On create an empty optional field has nothing to clear, so it is
            // omitted. On edit the user emptying a box IS the instruction to
            // clear it, and null — not '' — is what the DTOs accept for that.
            { emptyValues: mode === 'create' ? 'omit' : 'null' },
        );
        // Omitted when the employment type fixes it — the server is the source
        // of truth and rejects a contradicting value.
        if (lockedBasis) delete governed.salaryType;
        // Server-generated from the department; the form only previews it.
        delete governed.employeeCode;

        try {
            setLoading(true);
            setConfirmLoading(true);

            if (mode === 'create') {
                const employeeResult = await employeeService.create(governed as any);
                const newEmployeeId = employeeResult.data?.id;

                await saveProfileValues(newEmployeeId, profileValues);

                if (initialContract?.enabled && newEmployeeId && initialContract.contractType && initialContract.startDate) {
                    try {
                        await contractService.create({
                            employeeId: newEmployeeId,
                            contractType: initialContract.contractType,
                            startDate: initialContract.startDate,
                            endDate: initialContract.endDate || undefined,
                            salary: Number(data.baseSalary) || 0,
                            workType: initialContract.workType || 'FULL_TIME',
                            workHoursPerWeek: initialContract.workHoursPerWeek
                                ? parseInt(initialContract.workHoursPerWeek)
                                : 40,
                            notes: initialContract.notes || undefined,
                        });
                        toast.success(t('createSuccess'));
                    } catch (contractError: unknown) {
                        toast.success(t('createSuccessNoContract'));
                        toast.error(
                            t('contractNotAssigned', {
                                error: getApiErrorMessage(contractError, t('contractAssignFailed')),
                            }),
                        );
                    }
                } else {
                    toast.success(t('createSuccessNoContract'));
                }
            } else if (employeeId) {
                // Neither is accepted on PATCH, deliberately: a start-date change
                // rewrites payroll history and a branch change crosses the
                // isolation axis, so both need their own reviewed flow.
                delete governed.startDate;
                delete governed.branchId;
                // Empty string clears the override (null); a uuid sets it.
                if ('overtimePolicyId' in governed) {
                    governed.overtimePolicyId = governed.overtimePolicyId || null;
                }
                await employeeService.update(employeeId, governed as any);
                await saveProfileValues(employeeId, profileValues);
                toast.success(t('updateSuccess'));
            }

            setConfirmLoading(false);
            closeModal();
            router.push('/dashboard/employees');
        } catch (error: unknown) {
            // Per-field messages land on their controls; only fall back to a
            // banner when the server sent none. Without this the precise reason
            // collapses into one generic toast.
            if (!applyServerErrors(error, setError)) {
                toast.error(getApiErrorMessage(error, t('genericError')));
            }
            setConfirmLoading(false);
        } finally {
            setLoading(false);
        }
    };

    if (loadingData || templateLoading || !template) {
        return (
            <div className="animate-pulse space-y-6">
                <div className="h-8 bg-surface-border-light rounded-[--radius-input] w-64"></div>
                <div className="bg-surface-card rounded-[--radius-card] p-8 space-y-6 border border-surface-border">
                    {[...Array(8)].map((_, i) => (
                        <div key={i} className="h-12 bg-surface-page rounded-[--radius-input]"></div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <>
            <ConfirmDialog />
            <div className="max-w-4xl mx-auto space-y-6">
                {/* The heading itself is declared to TopHeader above; only the
                    back affordance belongs on the page. */}
                <PageActionRow
                    onBack={() => router.back()}
                />

                <form
                    data-testid="emp-form"
                    onSubmit={handleSubmit(onSubmit)}
                    className="bg-surface-card rounded-[--radius-card] p-8 border border-surface-border space-y-6"
                >
                    {basisWillChange && (
                        <div className="flex items-start gap-2 text-sm text-status-warning bg-status-warning/10 border border-status-warning/30 rounded-[--radius-input] px-3 py-2">
                            <Lock size={16} className="mt-0.5 shrink-0" />
                            <span>
                                {t('payBasisChangeWarning', {
                                    type: watchedEmploymentType || '',
                                    basis: payBasisLabel(lockedBasis!, tp),
                                })}
                            </span>
                        </div>
                    )}

                    <TemplateFormRenderer
                        template={template}
                        form={form}
                        readOnlyFields={readOnlyFields}
                        optionSources={optionSources}
                        renderField={renderField}
                        renderSectionFooter={renderSectionFooter}
                    />

                    {/* Contract Section - Create mode only. A different entity, so
                        it stays hand-written rather than becoming template data. */}
                    {mode === 'create' && (
                        <div>
                            <h2 className="text-lg font-bold text-brand-primary mb-4 pb-2 border-b-2 border-brand-primary-light/20">
                                {t('contractInfoHeading')}{' '}
                                <span className="text-sm font-normal text-text-muted">{t('optionalSuffix')}</span>
                            </h2>
                            <div className="flex items-center gap-3 mb-4">
                                <input
                                    type="checkbox"
                                    id="contract-enabled"
                                    {...register('initialContract.enabled')}
                                    className="w-4 h-4 rounded border-surface-border text-brand-primary focus:ring-brand-primary/20 cursor-pointer"
                                />
                                <label htmlFor="contract-enabled" className="text-sm font-medium text-text-heading cursor-pointer">
                                    {t('assignContractNow')}
                                </label>
                            </div>
                            {contractEnabled && (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div>
                                        <label className="block text-sm font-medium text-text-heading mb-2">
                                            {t('contractTypeLabel')} <span className="text-status-error">*</span>
                                        </label>
                                        <select
                                            {...register('initialContract.contractType')}
                                            className={`w-full px-4 py-2 border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body ${
                                                (errors.initialContract as any)?.contractType ? 'border-status-error' : 'border-surface-border'
                                            }`}
                                        >
                                            <option value="">{t('selectContractType')}</option>
                                            <option value="PROBATION">{t('contractProbation')}</option>
                                            <option value="FIXED_TERM">{t('contractFixedTerm')}</option>
                                            <option value="INDEFINITE">{t('contractIndefinite')}</option>
                                        </select>
                                        {(errors.initialContract as any)?.contractType && (
                                            <p className="mt-1 text-sm text-status-error">
                                                {(errors.initialContract as any).contractType.message}
                                            </p>
                                        )}
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-text-heading mb-2">
                                            {t('workModeLabel')}
                                        </label>
                                        <select
                                            {...register('initialContract.workType')}
                                            className="w-full px-4 py-2 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body"
                                        >
                                            <option value="FULL_TIME">{t('workModeFullTime')}</option>
                                            <option value="PART_TIME">{t('workModePartTime')}</option>
                                        </select>
                                    </div>
                                    {watchedWorkType === 'PART_TIME' && (
                                        <div>
                                            <label className="block text-sm font-medium text-text-heading mb-2">
                                                {t('hoursPerWeekLabel')} <span className="text-status-error">*</span>
                                            </label>
                                            <input
                                                {...register('initialContract.workHoursPerWeek')}
                                                type="number"
                                                min={1}
                                                onWheel={(e) => e.currentTarget.blur()}
                                                className={`w-full px-4 py-2 border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body ${
                                                    (errors.initialContract as any)?.workHoursPerWeek ? 'border-status-error' : 'border-surface-border'
                                                }`}
                                                placeholder={t('hoursPerWeekPlaceholder')}
                                            />
                                            {(errors.initialContract as any)?.workHoursPerWeek && (
                                                <p className="mt-1 text-sm text-status-error">
                                                    {(errors.initialContract as any).workHoursPerWeek.message}
                                                </p>
                                            )}
                                        </div>
                                    )}
                                    <div>
                                        <label className="block text-sm font-medium text-text-heading mb-2">
                                            {t('contractStartDateLabel')} <span className="text-status-error">*</span>
                                        </label>
                                        <input
                                            {...register('initialContract.startDate')}
                                            type="date"
                                            min={startDateBounds.min}
                                            max={startDateBounds.max}
                                            className={`w-full px-4 py-2 border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body ${
                                                (errors.initialContract as any)?.startDate ? 'border-status-error' : 'border-surface-border'
                                            }`}
                                        />
                                        <p className="mt-1 text-xs text-text-secondary">{t('startDateHint')}</p>
                                        {(errors.initialContract as any)?.startDate && (
                                            <p className="mt-1 text-sm text-status-error">
                                                {(errors.initialContract as any).startDate.message}
                                            </p>
                                        )}
                                    </div>
                                    {watchedContractType !== 'INDEFINITE' && (
                                        <div>
                                            <label className="block text-sm font-medium text-text-heading mb-2">
                                                {t('contractEndDateLabel')}{' '}
                                                {watchedContractType && <span className="text-status-error">*</span>}
                                            </label>
                                            <input
                                                {...register('initialContract.endDate')}
                                                type="date"
                                                className={`w-full px-4 py-2 border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body ${
                                                    (errors.initialContract as any)?.endDate ? 'border-status-error' : 'border-surface-border'
                                                }`}
                                            />
                                            {(errors.initialContract as any)?.endDate && (
                                                <p className="mt-1 text-sm text-status-error">
                                                    {(errors.initialContract as any).endDate.message}
                                                </p>
                                            )}
                                        </div>
                                    )}
                                    <div className="md:col-span-2">
                                        <label className="block text-sm font-medium text-text-heading mb-2">
                                            {tc('notes')}{' '}
                                            <span className="text-sm font-normal text-text-muted">{t('notesOptional')}</span>
                                        </label>
                                        <textarea
                                            {...register('initialContract.notes')}
                                            rows={2}
                                            className="w-full px-4 py-2 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary/20 bg-surface-card text-text-body resize-none"
                                            placeholder={t('notesPlaceholder')}
                                        />
                                    </div>
                                    <div className="md:col-span-2">
                                        <p className="text-xs text-text-muted bg-surface-page border border-surface-border rounded-[--radius-input] px-3 py-2">
                                            {t('contractSalaryNote')}
                                            {Number(watch('baseSalary')) > 0
                                                ? t('contractSalaryAmount', {
                                                      amount: formatCurrency(Number(watch('baseSalary'))),
                                                  })
                                                : t('contractSalaryMissing')}
                                        </p>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center justify-end gap-4 pt-6 border-t border-surface-border">
                        <button
                            data-testid="emp-form-cancel"
                            type="button"
                            onClick={() => router.back()}
                            className="flex items-center gap-2 px-6 py-2 border border-surface-border text-text-heading rounded-[--radius-button] hover:bg-surface-page transition-colors"
                        >
                            <X size={18} /> {tc('cancel')}
                        </button>
                        <button
                            data-testid="emp-form-submit"
                            type="submit"
                            disabled={loading}
                            className="flex items-center gap-2 px-6 py-2 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loading ? (
                                <>
                                    <div className="w-5 h-5 border-2 border-text-on-brand border-t-transparent rounded-full animate-spin"></div>
                                    <span>{t('savingBtn')}</span>
                                </>
                            ) : (
                                <>
                                    <Save size={18} />
                                    <span>{mode === 'create' ? t('createNewBtn') : t('updateBtn')}</span>
                                </>
                            )}
                        </button>
                    </div>
                </form>
            </div>
        </>
    );
}
