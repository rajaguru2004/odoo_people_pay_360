'use client';

import { use, useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { usePageHeader } from '@/hooks/usePageHeader';
import {
    Mail, Phone, Calendar, Building, User,
    FolderOpen, MapPin, Clock, Briefcase, MoreHorizontal, Download, Share2, Edit2, Trash2,
    CheckCircle, AlertTriangle, Info, Shield, GraduationCap, CreditCard, Award, X, Globe, UserCheck
} from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { motion } from 'framer-motion';
import employeeService from '@/services/employeeService';
import systemSettingsService from '@/services/systemSettingsService';
import teamService from '@/services/teamService';
import { employeeProfileService } from '@/services/employeeProfileService';
import { Employee } from '@/types/employee';
import { EmployeeTeam } from '@/types/team';
import { EmployeeProfile, EmployeeDocument, DocumentType, MARITAL_STATUS_LABEL_KEYS, EDUCATION_LABEL_KEYS } from '@/types/employee-profile';
import { formatDate, formatCurrency } from '@/utils/formatters';
import SalaryStructure from '@/components/employees/SalaryStructure';
import ProfileCompletionBar from '@/components/employees/ProfileCompletionBar';
import DocumentUpload from '@/components/employees/DocumentUpload';
import DocumentList from '@/components/employees/DocumentList';
import ActivityTimeline from '@/components/employees/ActivityTimeline';
import AvatarUpload from '@/components/employees/AvatarUpload';
import EmployeeProfileForm from '@/components/employees/EmployeeProfileForm';
import EmployeeRewardsAndDisciplines from '@/components/employees/EmployeeRewardsAndDisciplines';
import VisaSection from '@/components/employees/VisaSection';
import SupervisorSection from '@/components/employees/SupervisorSection';
import { toast } from '@/lib/toast';
import { getApiErrorMessage } from '@/lib/apiError';
import { useAuthStore } from '@/store/authStore';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { payBasisLabel, rateLabel, rateSuffix, toSalaryBasis } from '@/utils/payBasis';
import TemplateReadView from '@/components/dynamic-form/TemplateReadView';
import { useProfileTemplate } from '@/hooks/useProfileTemplate';
import overtimePolicyService, { PolicyResolution } from '@/services/overtimePolicyService';
import OvertimePolicyModal from '@/components/employees/OvertimePolicyModal';

/** Mirrors TAB_SECTION in EmployeeProfileForm — the read and edit views of a
 *  tab must always show the same fields. */
const PROFILE_TAB_SECTION: Record<'personal' | 'emergency' | 'education' | 'bank', string> = {
    personal: 'personal_extended',
    emergency: 'emergency_contact',
    education: 'education',
    bank: 'insurance_tax',
};

export default function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const router = useRouter();
    const { id } = use(params);
    const { user } = useAuthStore();
    const t = useTranslations('employeeDetailPage');
    const tp = useTranslations('employeeProfileLabels');
    const tc = useTranslations('common');
    // Shared pay-basis strings, consumed by utils/payBasis.ts helpers.
    const tpb = useTranslations('payBasis');
    const tv = useTranslations('visas');
    const [employee, setEmployee] = useState<Employee | null>(null);
    const [teams, setTeams] = useState<EmployeeTeam[]>([]);
    const [profile, setProfile] = useState<Partial<EmployeeProfile>>({});
    const [documents, setDocuments] = useState<EmployeeDocument[]>([]);
    const [loading, setLoading] = useState(true);

    // The one heading for this route, rendered by TopHeader — and the record crumb
    // PageBreadcrumbs appends, so the trail names the person instead of stopping on
    // Employee Directory and marking IT the current page. This page used to draw its
    // own `Employee > <name>` trail; that became a second trail once DashboardLayout
    // started rendering one for every route. Declared above the loading/not-found
    // early-returns so the hook order never changes.
    usePageHeader(employee?.fullName ?? t('breadcrumbEmployee'), employee?.employeeCode);
    const searchParams = useSearchParams();
    const [activeSection, setActiveSection] = useState<'profile' | 'documents' | 'visa' | 'supervisor' | 'salary' | 'rewards' | 'activity'>(
        searchParams.get('section') === 'visa' ? 'visa' : 'profile'
    );
    const [activeProfileTab, setActiveProfileTab] = useState<'personal' | 'emergency' | 'education' | 'bank'>('personal');

    // Same tab -> section mapping the edit form uses, matched on the immutable
    // sectionKey rather than the label an admin may have renamed.
    const { data: profileTemplate } = useProfileTemplate({ mode: 'EDIT', employeeId: id });
    const readSectionsFor = useCallback(
        (tab: 'personal' | 'emergency' | 'education' | 'bank') => {
            const key = PROFILE_TAB_SECTION[tab];
            return (profileTemplate?.sections ?? []).filter(s => s.sectionKey === key);
        },
        [profileTemplate],
    );
    // Which profile section is being edited in the modal (null = closed).
    const [editSection, setEditSection] = useState<'personal' | 'emergency' | 'education' | 'bank' | null>(null);
    const [showActionMenu, setShowActionMenu] = useState(false);
    const [activityRefreshKey, setActivityRefreshKey] = useState(0);
    const [resendingEmail, setResendingEmail] = useState(false);
    const [hardDeleteEnabled, setHardDeleteEnabled] = useState(false);
    const [resolvedPolicy, setResolvedPolicy] = useState<PolicyResolution | null>(null);
    const [showPolicyModal, setShowPolicyModal] = useState(false);

    // Permission checks
    const canViewSalary = ['ADMIN', 'HR_MANAGER'].includes(user?.role || '');
    // Visa records are legal documents: employees view their own, only HR/admin manage.
    const canManageVisas = ['ADMIN', 'HR_MANAGER'].includes(user?.role || '');
    const canEditProfile = ['ADMIN', 'HR_MANAGER'].includes(user?.role || '') || user?.employee?.id === id;
    const canDeleteEmployee = ['ADMIN', 'HR_MANAGER'].includes(user?.role || '');

    useEffect(() => {
        fetchEmployee();
    }, [id]);

    useEffect(() => {
        if (!canDeleteEmployee) return;
        systemSettingsService.getAll().then(res => {
            if (res?.success) {
                const item = res.data.find((s: any) => s.key === 'allow_hard_delete_terminated');
                setHardDeleteEnabled(item?.value === 'true');
            }
        }).catch(() => {});
    }, [canDeleteEmployee]);

    const fetchEmployee = async () => {
        try {
            setLoading(true);
            const [empRes, teamsRes] = await Promise.all([
                employeeService.getById(id),
                teamService.getEmployeeTeams(id)
            ]);

            setEmployee(empRes.data);
            setTeams(teamsRes.data);

            try {
                const profileRes = await employeeProfileService.getProfile(id);

                // profileRes = { success: true, data: { ...employee, profile: {...}, documents: [...] } }
                const employeeData = profileRes.data || profileRes; // Handle both wrapped and unwrapped

                if (employeeData) {
                    setProfile({
                        ...(employeeData.profile || {}),
                        profileCompletionPercentage: employeeData.profileCompletionPercentage
                    });
                    // Filter out AVATAR documents - avatar is not a document
                    const realDocuments = (employeeData.documents || []).filter(
                        (doc: any) => doc.documentType !== 'AVATAR'
                    );
                    setDocuments(realDocuments);
                }
            } catch (profileError) {
                console.error('❌ Profile fetch error:', profileError);
                setProfile({});
                setDocuments([]);
            }

            try {
                const otRes = await overtimePolicyService.resolve(id);
                if (otRes?.data) setResolvedPolicy(otRes.data);
            } catch (otErr) {
                console.error('Overtime policy resolve error:', otErr);
            }
        } catch (error) {
            console.error('Failed to fetch employee:', error);
            toast.error(t('noStaffFound'));
            router.push('/dashboard/employees');
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async () => {
        if (!canDeleteEmployee) {
            toast.error(t('noDeletePermission'));
            return;
        }
        if (!confirm(t('confirmDelete'))) return;
        try {
            await employeeService.delete(id);
            toast.success(t('deleteSuccess'));
            router.push('/dashboard/employees');
        } catch (error: any) {
            toast.error(getApiErrorMessage(error, t('deleteFailed')));
        }
    };

    const handleHardDelete = async () => {
        if (!canDeleteEmployee) {
            toast.error(t('noDeletePermission'));
            return;
        }
        if (!confirm(
            t('permanentDeleteConfirm', { name: employee?.fullName || '' })
        )) return;
        try {
            await employeeService.hardDelete(id);
            toast.success(t('permanentDeleteSuccess'));
            router.push('/dashboard/employees');
        } catch (error: any) {
            toast.error(getApiErrorMessage(error, t('permanentDeleteFailed')));
        }
    };

    const handleResendCredentials = async () => {
        if (!['ADMIN', 'HR_MANAGER'].includes(user?.role || '')) {
            toast.error(t('noResendPermission'));
            return;
        }
        try {
            setResendingEmail(true);
            await employeeService.resendWelcomeEmail(id);
            toast.success(t('resendSuccess'));
            setShowActionMenu(false);
        } catch (error: any) {
            toast.error(getApiErrorMessage(error, t('resendFailed')));
        } finally {
            setResendingEmail(false);
        }
    };

    const handleAvatarUpload = async (file: File) => {
        try {
            console.log('🔄 Starting avatar upload...');
            const response = await employeeProfileService.uploadAvatar(id, file);
            console.log('✅ Avatar upload response:', response);

            // Backend returns { success, message, data: { ...document, avatarUrl, fileUrl } };
            // the service unwraps one `data` level, so the fields sit on `response`.
            // Check both shapes to stay resilient to that unwrapping.
            const avatarUrl =
                response?.avatarUrl ||
                response?.fileUrl ||
                response?.data?.avatarUrl ||
                response?.data?.fileUrl;

            if (avatarUrl) {
                console.log('📸 New avatar URL:', avatarUrl);

                // Update employee state immediately with new avatar
                setEmployee(prev => prev ? {
                    ...prev,
                    avatarUrl: avatarUrl
                } : null);

                toast.success(t('avatarUpdateSuccess'));

                // Refresh activity timeline
                setActivityRefreshKey(prev => prev + 1);
            } else {
                console.warn('⚠️ No avatarUrl in response, but upload may have succeeded');
                console.log('Response structure:', JSON.stringify(response, null, 2));

                // Still show success and refresh
                toast.success(t('avatarUpdateSuccess'));
                setActivityRefreshKey(prev => prev + 1);

                // Force refresh employee data to get new avatar
                await fetchEmployee();
            }
        } catch (error: any) {
            console.error('❌ Avatar upload failed:', error);
            toast.error(getApiErrorMessage(error, t('imageUploadFailed')));
            throw error;
        }
    };

    const handleProfileSave = async (data: Partial<EmployeeProfile>) => {
        if (!canEditProfile) {
            toast.error(t('noEditPermission'));
            return;
        }

        // Optimistic update
        const previousProfile = profile;
        setProfile({ ...profile, ...data });

        try {
            console.log('Saving profile data:', data);
            const response = await employeeProfileService.updateProfile(id, data);
            console.log('Profile save response:', response);

            // Update with server response
            if (response.data) {
                setProfile({
                    ...(response.data || {}),
                    profileCompletionPercentage: profile.profileCompletionPercentage
                });
            }

            toast.success(t('profileUpdateSuccess'));
            // Refresh activity timeline
            setActivityRefreshKey(prev => prev + 1);

            // Refetch employee and profile data to get fresh completion stats
            await fetchEmployee();
        } catch (error: any) {
            // Rollback on error
            setProfile(previousProfile);
            console.error('Profile save failed:', error);
            toast.error(getApiErrorMessage(error, t('saveFailed')));
            throw error;
        }
    };

    const handleDocumentUpload = async (file: File, documentType: string, description?: string) => {
        // Optimistic update
        const tempDoc: Partial<EmployeeDocument> = {
            id: `temp-${Date.now()}`,
            employeeId: id,
            fileName: file.name,
            fileUrl: URL.createObjectURL(file), // Temporary URL for preview
            fileSize: file.size,
            mimeType: file.type,
            documentType: documentType as unknown as DocumentType,
            description: description,
            uploadedAt: new Date().toISOString(),
        };
        setDocuments([...documents, tempDoc as EmployeeDocument]);

        try {
            const response = await employeeProfileService.uploadDocument(id, file, documentType, description);
            // Replace temp with real document
            setDocuments(docs => docs.map(d => d.id === tempDoc.id ? response.data : d));
            toast.success(t('documentUploadSuccess'));
            // Refresh activity timeline
            setActivityRefreshKey(prev => prev + 1);
            // Refetch employee details to update completion stats
            await fetchEmployee();
        } catch (error: any) {
            // Remove temp document on error
            setDocuments(docs => docs.filter(d => d.id !== tempDoc.id));
            console.error('Document upload failed:', error);
            toast.error(getApiErrorMessage(error, t('uploadFailed')));
            throw error;
        }
    };

    const handleDocumentDelete = async (documentId: string) => {
        // Optimistic update
        const previousDocuments = documents;
        setDocuments(docs => docs.filter(d => d.id !== documentId));

        try {
            await employeeProfileService.deleteDocument(id, documentId);
            toast.success(t('documentDeleteSuccess'));
            // Refresh activity timeline
            setActivityRefreshKey(prev => prev + 1);
            // Refetch employee details to update completion stats
            await fetchEmployee();
        } catch (error: any) {
            // Rollback on error
            setDocuments(previousDocuments);
            console.error('Document delete failed:', error);
            toast.error(getApiErrorMessage(error, t('documentDeleteFailed')));
            throw error;
        }
    };

    if (loading) {
        return (
            <>
                <div className="max-w-7xl mx-auto px-6 py-8">
                    <div className="animate-pulse space-y-6">
                        <div className="h-6 bg-slate-200 rounded w-48"></div>
                        <div className="h-32 bg-slate-100 rounded-xl"></div>
                        <div className="grid grid-cols-3 gap-6">
                            <div className="h-96 bg-slate-100 rounded-xl"></div>
                            <div className="col-span-2 space-y-4">
                                {[...Array(4)].map((_, i) => (
                                    <div key={i} className="h-24 bg-slate-100 rounded-xl"></div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </>
        );
    }

    if (!employee) return null;

    // baseSalary means nothing without its basis: a monthly amount for MONTHLY
    // staff, a per-day rate for daily wage.
    const employeeBasis = toSalaryBasis(employee.salaryType);

    return (
        <ProtectedRoute requiredPermission="VIEW_EMPLOYEES" selfEmployeeId={id}>
            <>
                <div className="max-w-7xl mx-auto px-6 py-8">
                    {/* Hero Header - Redesigned */}
                    <div className="bg-gradient-to-br from-blue-50 via-white to-purple-50 rounded-2xl border-2 border-slate-200 p-8 mb-6 shadow-sm">
                        <div className="flex items-start justify-between">
                            <div className="flex items-start gap-8">
                                {/* Avatar - Larger size without status badge */}
                                <div className="relative flex-shrink-0">
                                    <AvatarUpload
                                        currentAvatar={employee.avatarUrl}
                                        employeeName={employee.fullName}
                                        onUpload={handleAvatarUpload}
                                        disabled={!canEditProfile}
                                    />
                                </div>

                                {/* Info Section */}
                                <div className="flex-1 pt-2">
                                    {/* Name and Status */}
                                    <div className="flex items-center gap-3 mb-3">
                                        <h2 data-testid="emp-detail-name" className="text-4xl font-bold text-slate-900">{employee.fullName}</h2>
                                        <div data-testid="emp-detail-status" className={`px-4 py-1.5 text-white text-sm font-bold rounded-full shadow-md flex items-center gap-2 ${employee.status === 'ACTIVE' ? 'bg-green-500' :
                                            employee.status === 'ON_LEAVE' ? 'bg-yellow-500' :
                                                'bg-red-500'
                                            }`}>
                                            <div className="w-2 h-2 bg-white rounded-full animate-pulse"></div>
                                            {employee.status === 'ACTIVE' ? tc('active') :
                                                employee.status === 'ON_LEAVE' ? tc('onLeaveStatus') :
                                                    tc('inactive')}
                                        </div>
                                    </div>

                                    {/* Position */}
                                    <p className="text-xl text-brand-primary font-semibold mb-6">{employee.position}</p>

                                    {/* Quick Info Grid */}
                                    <div className="grid grid-cols-3 gap-6">
                                        <div className="flex items-center gap-3 text-slate-600">
                                            <div className="w-10 h-10 rounded-xl bg-brand-primary-light/20 flex items-center justify-center flex-shrink-0">
                                                <Building size={20} className="text-brand-primary" />
                                            </div>
                                            <div>
                                                <p className="text-xs text-slate-500 font-medium">{t('quickInfoDepartments')}</p>
                                                <p data-testid="emp-detail-department" className="text-sm font-bold text-slate-900">{employee.department?.name}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3 text-slate-600">
                                            <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center flex-shrink-0">
                                                <Calendar size={20} className="text-purple-600" />
                                            </div>
                                            <div>
                                                <p className="text-xs text-slate-500 font-medium">{t('quickInfoHireDate')}</p>
                                                <p className="text-sm font-bold text-slate-900">{formatDate(employee.startDate)}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3 text-slate-600">
                                            <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center flex-shrink-0">
                                                <User size={20} className="text-brand-accent-dark" />
                                            </div>
                                            <div>
                                                <p className="text-xs text-slate-500 font-medium">{t('quickInfoEmployeeId')}</p>
                                                <p data-testid="emp-detail-code" className="text-sm font-bold text-slate-900">{employee.employeeCode}</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-2">
                                <button
                                    data-testid="emp-detail-edit"
                                    onClick={() => router.push(`/dashboard/employees/${id}/edit`)}
                                    className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-brand-primary to-brand-primary text-white rounded-xl hover:shadow-xl transition-all font-semibold"
                                >
                                    <Edit2 size={18} />
                                    <span>{t('editBtn')}</span>
                                </button>
                                <div className="relative">
                                    <button
                                        data-testid="emp-detail-actions"
                                        onClick={() => setShowActionMenu(!showActionMenu)}
                                        className="p-3 bg-white border-2 border-slate-200 rounded-xl hover:bg-slate-50 hover:border-brand-primary transition-all"
                                    >
                                        <MoreHorizontal size={20} />
                                    </button>
                                    {showActionMenu && (
                                        <div className="absolute end-0 mt-2 w-48 bg-white rounded-xl shadow-xl border border-slate-200 py-2 z-10">
                                            <button className="w-full px-4 py-2.5 text-start text-sm hover:bg-slate-50 flex items-center gap-3 text-slate-700">
                                                <Download size={16} />
                                                {t('exportPdf')}
                                            </button>
                                            <button className="w-full px-4 py-2.5 text-start text-sm hover:bg-slate-50 flex items-center gap-3 text-slate-700">
                                                <Share2 size={16} />
                                                {t('share')}
                                            </button>
                                            {canDeleteEmployee && (
                                                <>
                                                    <div className="border-t border-slate-200 my-2"></div>
                                                    <button
                                                        data-testid="emp-detail-resend"
                                                        onClick={handleResendCredentials}
                                                        disabled={resendingEmail}
                                                        className="w-full px-4 py-2.5 text-start text-sm hover:bg-slate-50 flex items-center gap-3 text-slate-700 disabled:opacity-50"
                                                    >
                                                        <Mail size={16} />
                                                        {resendingEmail ? t('sendingCredentials') : t('resendCredentials')}
                                                    </button>
                                                    <button
                                                        data-testid="emp-detail-delete"
                                                        onClick={handleDelete}
                                                        className="w-full px-4 py-2.5 text-start text-sm hover:bg-red-50 text-red-600 flex items-center gap-3"
                                                    >
                                                        <Trash2 size={16} />
                                                        {t('deleteEmployee')}
                                                    </button>
                                                    {hardDeleteEnabled && employee.status === 'TERMINATED' && (
                                                        <button
                                                            data-testid="emp-detail-hard-delete"
                                                            onClick={handleHardDelete}
                                                            className="w-full px-4 py-2.5 text-start text-sm hover:bg-red-100 text-red-700 font-semibold flex items-center gap-3"
                                                        >
                                                            <Trash2 size={16} />
                                                            {t('permanentlyDelete')}
                                                        </button>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Main Content */}
                    <div className="grid grid-cols-12 gap-6">
                        {/* Sidebar Navigation */}
                        <div className="col-span-3">
                            <div className="surface-panel p-3 sticky top-6 shadow-sm">
                                <nav className="space-y-1">
                                    <button
                                        data-testid="emp-section-profile"
                                        onClick={() => setActiveSection('profile')}
                                        className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeSection === 'profile'
                                            ? 'bg-gradient-to-r from-brand-primary via-brand-primary to-brand-primary-dark text-white shadow-lg'
                                            : 'text-slate-700 hover:bg-slate-50'
                                            }`}
                                    >
                                        <User size={18} />
                                        <span>{t('navDetailedProfile')}</span>
                                    </button>
                                    <button
                                        data-testid="emp-section-documents"
                                        onClick={() => setActiveSection('documents')}
                                        className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeSection === 'documents'
                                            ? 'bg-gradient-to-r from-brand-primary via-brand-primary to-brand-primary-dark text-white shadow-lg'
                                            : 'text-slate-700 hover:bg-slate-50'
                                            }`}
                                    >
                                        <FolderOpen size={18} />
                                        <span>{t('navDocuments')}</span>
                                        {documents.length > 0 && (
                                            <span className={`ms-auto px-2 py-0.5 rounded-full text-xs font-bold ${activeSection === 'documents'
                                                ? 'bg-white/20 text-white'
                                                : 'bg-slate-200 text-slate-700'
                                                }`}>
                                                {documents.length}
                                            </span>
                                        )}
                                    </button>
                                    <button
                                        data-testid="emp-section-visa"
                                        onClick={() => setActiveSection('visa')}
                                        className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeSection === 'visa'
                                            ? 'bg-gradient-to-r from-brand-primary via-brand-primary to-brand-primary-dark text-white shadow-lg'
                                            : 'text-slate-700 hover:bg-slate-50'
                                            }`}
                                    >
                                        <Globe size={18} />
                                        <span>{tv('title')}</span>
                                    </button>
                                    <button
                                        data-testid="emp-section-supervisor"
                                        onClick={() => setActiveSection('supervisor')}
                                        className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeSection === 'supervisor'
                                            ? 'bg-gradient-to-r from-brand-primary via-brand-primary to-brand-primary-dark text-white shadow-lg'
                                            : 'text-slate-700 hover:bg-slate-50'
                                            }`}
                                    >
                                        <UserCheck size={18} />
                                        <span>Supervisor</span>
                                    </button>
                                    {canViewSalary && (
                                        <button
                                            data-testid="emp-section-salary"
                                            onClick={() => setActiveSection('salary')}
                                            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeSection === 'salary'
                                                ? 'bg-gradient-to-r from-brand-primary via-brand-primary to-brand-primary-dark text-white shadow-lg'
                                                : 'text-slate-700 hover:bg-slate-50'
                                                }`}
                                        >
                                            <CurrencyIcon size={18} />
                                            <span>{t('navSalaryStructure')}</span>
                                        </button>
                                    )}
                                    <button
                                        data-testid="emp-section-rewards"
                                        onClick={() => setActiveSection('rewards')}
                                        className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeSection === 'rewards'
                                            ? 'bg-gradient-to-r from-brand-primary via-brand-primary to-brand-primary-dark text-white shadow-lg'
                                            : 'text-slate-700 hover:bg-slate-50'
                                            }`}
                                    >
                                        <Award size={18} />
                                        <span>{t('navRewardsPenalties')}</span>
                                        {employee._count && (employee._count.rewards > 0 || employee._count.disciplines > 0) && (
                                            <span className={`ms-auto px-2 py-0.5 rounded-full text-xs font-bold ${activeSection === 'rewards'
                                                ? 'bg-white/20 text-white'
                                                : 'bg-slate-200 text-slate-700'
                                                }`}>
                                                {(employee._count.rewards || 0) + (employee._count.disciplines || 0)}
                                            </span>
                                        )}
                                    </button>
                                    <button
                                        data-testid="emp-section-activity"
                                        onClick={() => setActiveSection('activity')}
                                        className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-semibold transition-all ${activeSection === 'activity'
                                            ? 'bg-gradient-to-r from-brand-primary via-brand-primary to-brand-primary-dark text-white shadow-lg'
                                            : 'text-slate-700 hover:bg-slate-50'
                                            }`}
                                    >
                                        <Clock size={18} />
                                        <span>{t('navActivity')}</span>
                                    </button>
                                </nav>

                                {/* Quick Stats */}
                                {employee._count && (
                                    <div className="mt-6 pt-6 border-t border-slate-200 space-y-2">
                                        <p className="text-xs font-bold text-slate-500 uppercase px-4 mb-3">{t('quickStats')}</p>
                                        <div className="space-y-1">
                                            <div className="flex items-center justify-between px-4 py-2.5 rounded-lg hover:bg-slate-50 transition-colors">
                                                <span className="text-sm text-slate-600">{t('statContract')}</span>
                                                <span className="text-sm font-bold text-brand-primary">{employee._count.contracts}</span>
                                            </div>
                                            <div className="flex items-center justify-between px-4 py-2.5 rounded-lg hover:bg-slate-50 transition-colors">
                                                <span className="text-sm text-slate-600">{t('statWorkDay')}</span>
                                                <span className="text-sm font-bold text-green-600">{employee._count.attendances}</span>
                                            </div>
                                            <div className="flex items-center justify-between px-4 py-2.5 rounded-lg hover:bg-slate-50 transition-colors">
                                                <span className="text-sm text-slate-600">{t('statLeaveRequest')}</span>
                                                <span className="text-sm font-bold text-brand-accent-dark">{employee._count.leaveRequests}</span>
                                            </div>
                                            <div className="flex items-center justify-between px-4 py-2.5 rounded-lg hover:bg-slate-50 transition-colors">
                                                <span className="text-sm text-slate-600">{t('statReward')}</span>
                                                <span className="text-sm font-bold text-purple-600">{employee._count.rewards}</span>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Main Content Area */}
                        <div className="col-span-9">
                            {/* Profile Section */}
                            {activeSection === 'profile' && (
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="space-y-6"
                                >
                                    {/* Profile Completion Card - MOVED TO TOP */}
                                    <div className="surface-panel p-6">
                                        <div className="flex items-center justify-between mb-4">
                                            <div>
                                                <h3 className="text-lg font-bold text-slate-900">{t('profileCompletionHeading')}</h3>
                                                <p className="text-sm text-slate-600 mt-1">
                                                    <span className="font-bold text-brand-primary">{t('percentCompleted', { percent: profile?.profileCompletionPercentage || 0 })}</span>
                                                </p>
                                            </div>
                                            {(profile?.profileCompletionPercentage || 0) === 100 && (
                                                <div className="flex items-center gap-2 px-4 py-2 bg-green-100 text-green-700 rounded-full">
                                                    <CheckCircle size={18} />
                                                    <span className="text-sm font-semibold">{t('completeBadge')}</span>
                                                </div>
                                            )}
                                        </div>

                                        <ProfileCompletionBar
                                            percentage={profile?.profileCompletionPercentage || 0}
                                            showDetails={false}
                                        />

                                        {(profile?.profileCompletionPercentage || 0) < 100 && (
                                            <div className="mt-4 p-4 bg-brand-primary-light/10 rounded-xl border border-brand-primary-light/30 flex items-start gap-3">
                                                <Info className="text-brand-primary flex-shrink-0 mt-0.5" size={20} />
                                                <div>
                                                    <p className="text-sm text-brand-primary-dark">
                                                        <strong>{t('tipLabel')}</strong> {t('tipText')}
                                                    </p>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    {/* Basic Employee Information */}
                                    <div className="surface-panel p-6">
                                        <div className="flex items-center justify-between mb-4">
                                            <h3 className="text-lg font-bold text-slate-900">{t('basicInfoHeading')}</h3>
                                            <button
                                                onClick={() => router.push(`/dashboard/employees/${id}/edit`)}
                                                className="text-sm text-brand-primary hover:text-brand-primary font-semibold flex items-center gap-1"
                                            >
                                                <Edit2 size={16} />
                                                {t('editLabel')}
                                            </button>
                                        </div>
                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                            <div className="p-4 bg-slate-50 rounded-xl">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <Mail size={16} className="text-brand-primary" />
                                                    <p className="text-xs text-slate-500">{tc('email')}</p>
                                                </div>
                                                <p className="text-sm font-semibold text-slate-900">{employee.email}</p>
                                            </div>
                                            <div className="p-4 bg-slate-50 rounded-xl">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <Phone size={16} className="text-green-600" />
                                                    <p className="text-xs text-slate-500">{tc('phoneNumber')}</p>
                                                </div>
                                                <p className="text-sm font-semibold text-slate-900">{employee.phone || t('notUpdatedYet')}</p>
                                            </div>
                                            <div className="p-4 bg-slate-50 rounded-xl">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <Calendar size={16} className="text-purple-600" />
                                                    <p className="text-xs text-slate-500">{t('dobLabel')}</p>
                                                </div>
                                                <p className="text-sm font-semibold text-slate-900">{formatDate(employee.dateOfBirth)}</p>
                                            </div>
                                            <div className="p-4 bg-slate-50 rounded-xl">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <User size={16} className="text-brand-accent-dark" />
                                                    <p className="text-xs text-slate-500">Gender</p>
                                                </div>
                                                <p className="text-sm font-semibold text-slate-900">{employee.gender || t('notUpdatedYet')}</p>
                                            </div>
                                            <div className="p-4 bg-slate-50 rounded-xl">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <CreditCard size={16} className="text-red-600" />
                                                    <p className="text-xs text-slate-500">{t('cmndLabel')}</p>
                                                </div>
                                                <p className="text-sm font-semibold text-slate-900">{employee.idCard}</p>
                                            </div>
                                            <div className="p-4 bg-slate-50 rounded-xl">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <User size={16} className="text-brand-primary" />
                                                    <p className="text-xs text-slate-500">{t('quickInfoEmployeeId')}</p>
                                                </div>
                                                <p className="text-sm font-semibold text-slate-900">{employee.employeeCode}</p>
                                            </div>
                                            <div className="p-4 bg-slate-50 rounded-xl md:col-span-3">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <MapPin size={16} className="text-pink-600" />
                                                    <p className="text-xs text-slate-500">{tc('address')}</p>
                                                </div>
                                                <p className="text-sm font-semibold text-slate-900">
                                                    {employee.address || t('notUpdatedYet')}
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Work Information */}
                                    <div className="surface-panel p-6">
                                        <h3 className="text-lg font-bold text-slate-900 mb-4">{t('jobInfoHeading')}</h3>
                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                            <div className="p-4 bg-slate-50 rounded-xl">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <Building size={16} className="text-brand-primary" />
                                                    <p className="text-xs text-slate-500">{t('quickInfoDepartments')}</p>
                                                </div>
                                                <p className="text-sm font-semibold text-slate-900">{employee.department?.name}</p>
                                            </div>
                                            <div className="p-4 bg-slate-50 rounded-xl">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <User size={16} className="text-purple-600" />
                                                    <p className="text-xs text-slate-500">{tc('position')}</p>
                                                </div>
                                                <p className="text-sm font-semibold text-slate-900">{employee.position}</p>
                                            </div>
                                            <div className="p-4 bg-slate-50 rounded-xl">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <Calendar size={16} className="text-green-600" />
                                                    <p className="text-xs text-slate-500">{t('quickInfoHireDate')}</p>
                                                </div>
                                                <p className="text-sm font-semibold text-slate-900">{formatDate(employee.startDate)}</p>
                                            </div>
                                            <div className="p-4 bg-slate-50 rounded-xl">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <CheckCircle size={16} className="text-green-600" />
                                                    <p className="text-xs text-slate-500">{tc('status')}</p>
                                                </div>
                                                <span className={`inline-flex px-3 py-1 rounded-full text-xs font-semibold ${employee.status === 'ACTIVE' ? 'bg-green-100 text-green-700' :
                                                    employee.status === 'ON_LEAVE' ? 'bg-yellow-100 text-yellow-700' :
                                                        'bg-red-100 text-red-700'
                                                    }`}>
                                                    {employee.status}
                                                </span>
                                            </div>
                                            {canViewSalary && (
                                                <div className="p-4 bg-slate-50 rounded-xl">
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <CreditCard size={16} className="text-brand-primary" />
                                                        <p className="text-xs text-slate-500">{rateLabel(employeeBasis, tpb)}</p>
                                                    </div>
                                                    <p className="text-sm font-semibold text-brand-primary">
                                                        {formatCurrency(Number(employee.baseSalary))}
                                                        <span className="text-xs font-normal text-slate-500">{rateSuffix(employeeBasis, tpb)}</span>
                                                    </p>
                                                </div>
                                            )}
                                            {!canViewSalary && (
                                                <div className="p-4 bg-slate-50 rounded-xl">
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <Shield size={16} className="text-slate-400" />
                                                        <p className="text-xs text-slate-500">{rateLabel(employeeBasis, tpb)}</p>
                                                    </div>
                                                    <p className="text-sm font-semibold text-slate-400">••••••••</p>
                                                </div>
                                            )}
                                            {/* Pay basis stays visible without salary permission:
                                                the AMOUNT is confidential, the basis is not — and a
                                                figure with no basis is unreadable. */}
                                            <div className="p-4 bg-slate-50 rounded-xl">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <Clock size={16} className="text-brand-primary" />
                                                    <p className="text-xs text-slate-500">{t('payBasis')}</p>
                                                </div>
                                                <p className="text-sm font-semibold text-slate-800">
                                                    {payBasisLabel(employeeBasis, tpb)}
                                                </p>
                                            </div>
                                            <div className="p-4 bg-slate-50 rounded-xl">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <Briefcase size={16} className="text-brand-primary" />
                                                    <p className="text-xs text-slate-500">{t('employmentType')}</p>
                                                </div>
                                                <p className="text-sm font-semibold text-slate-800">
                                                    {employee.employmentType || '—'}
                                                </p>
                                            </div>
                                            <div className="p-4 bg-slate-50 rounded-xl">
                                                <div className="flex items-center justify-between mb-2">
                                                    <div className="flex items-center gap-2">
                                                        <Clock size={16} className="text-purple-600" />
                                                        <p className="text-xs text-slate-500">Overtime Policy</p>
                                                    </div>
                                                    {resolvedPolicy?.source && (
                                                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 border border-purple-200">
                                                            {resolvedPolicy.source === 'EMPLOYEE_OVERRIDE'
                                                                ? 'Direct Override'
                                                                : resolvedPolicy.source === 'EMPLOYMENT_TYPE'
                                                                ? 'Employment Type'
                                                                : resolvedPolicy.source === 'COMPANY_DEFAULT'
                                                                ? 'Company Default'
                                                                : 'System Global'}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="flex items-center justify-between gap-2 mt-1">
                                                    <p className="text-sm font-semibold text-slate-800 truncate">
                                                        {resolvedPolicy?.effectivePolicyName || 'Company Default Policy'}
                                                    </p>
                                                    <button
                                                        type="button"
                                                        onClick={() => setShowPolicyModal(true)}
                                                        className="text-xs font-semibold text-brand-primary hover:text-brand-primary-dark hover:underline flex items-center gap-1 shrink-0"
                                                    >
                                                        <Info size={14} />
                                                        <span>Details</span>
                                                    </button>
                                                </div>
                                            </div>
                                            {employee.endDate && (
                                                <div className="p-4 bg-slate-50 rounded-xl">
                                                    <div className="flex items-center gap-2 mb-2">
                                                        <Calendar size={16} className="text-red-600" />
                                                        <p className="text-xs text-slate-500">{t('endDateLabel')}</p>
                                                    </div>
                                                    <p className="text-sm font-semibold text-slate-900">{formatDate(employee.endDate)}</p>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Managed Departments — a manager may head more than one department */}
                                    {employee.managedDepartments && employee.managedDepartments.length > 0 && (
                                        <div className="surface-panel p-6">
                                            <div className="flex items-center gap-2 mb-4">
                                                <Shield size={18} className="text-brand-primary" />
                                                <h3 className="text-lg font-bold text-slate-900">{t('managesDepartmentsHeading')}</h3>
                                                <span className="ms-1 px-2 py-0.5 rounded-full text-xs font-bold bg-brand-primary-light/20 text-brand-primary">
                                                    {employee.managedDepartments.length}
                                                </span>
                                            </div>
                                            <div className="flex flex-wrap gap-2">
                                                {employee.managedDepartments.map((dept) => (
                                                    <button
                                                        key={dept.id}
                                                        onClick={() => router.push(`/dashboard/departments/${dept.id}`)}
                                                        className="inline-flex items-center gap-2 px-4 py-2 bg-slate-50 hover:bg-brand-primary-light/10 border border-slate-200 hover:border-brand-primary rounded-xl transition-all"
                                                    >
                                                        <Building size={16} className="text-brand-primary" />
                                                        <span className="text-sm font-semibold text-slate-900">{dept.name}</span>
                                                        <span className="text-xs text-slate-500">{dept.code}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Profile Data Display with Tabs (Read-only) */}
                                    <div className="surface-panel">
                                        {/* Tab Headers */}
                                        <div className="border-b border-gray-200">
                                            <div className="flex gap-2 overflow-x-auto p-3">
                                                <button
                                                    type="button"
                                                    onClick={() => setActiveProfileTab('personal')}
                                                    className={`flex items-center gap-2 px-4 py-3 border-b-2 font-semibold text-sm whitespace-nowrap transition-all ${activeProfileTab === 'personal'
                                                        ? 'border-brand-primary text-brand-primary'
                                                        : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                                                        }`}
                                                >
                                                    <User size={18} />
                                                    {tp('personalInfoTab')}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setActiveProfileTab('emergency')}
                                                    className={`flex items-center gap-2 px-4 py-3 border-b-2 font-semibold text-sm whitespace-nowrap transition-all ${activeProfileTab === 'emergency'
                                                        ? 'border-brand-primary text-brand-primary'
                                                        : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                                                        }`}
                                                >
                                                    <AlertTriangle size={18} />
                                                    {tp('emergencyContactTab')}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setActiveProfileTab('education')}
                                                    className={`flex items-center gap-2 px-4 py-3 border-b-2 font-semibold text-sm whitespace-nowrap transition-all ${activeProfileTab === 'education'
                                                        ? 'border-brand-primary text-brand-primary'
                                                        : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                                                        }`}
                                                >
                                                    <GraduationCap size={18} />
                                                    {tp('educationTab')}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setActiveProfileTab('bank')}
                                                    className={`flex items-center gap-2 px-4 py-3 border-b-2 font-semibold text-sm whitespace-nowrap transition-all ${activeProfileTab === 'bank'
                                                        ? 'border-brand-primary text-brand-primary'
                                                        : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                                                        }`}
                                                >
                                                    <CreditCard size={18} />
                                                    {tp('bankTab')}
                                                </button>
                                            </div>
                                        </div>

                                        {/* Tab Content */}
                                        <div className="p-6">
                                            {/* Edit Button */}
                                            <div className="flex justify-between items-center mb-6">
                                                <h3 className="text-lg font-semibold text-gray-900">
                                                    {activeProfileTab === 'personal' && tp('personalInfoTab')}
                                                    {activeProfileTab === 'emergency' && tp('emergencyContactTab')}
                                                    {activeProfileTab === 'education' && tp('educationTab')}
                                                    {activeProfileTab === 'bank' && t('bankTabHeading')}
                                                </h3>
                                                {canEditProfile && (
                                                    <button
                                                        onClick={() => setEditSection(activeProfileTab)}
                                                        className="text-sm text-brand-primary hover:text-brand-primary font-semibold flex items-center gap-1"
                                                    >
                                                        <Edit2 size={16} />
                                                        {t('editLabel')}
                                                    </button>
                                                )}
                                            </div>

                                            {/* Personal / Emergency / Education tabs are rendered
                                                from the active template, so a field an admin adds
                                                appears here too — the hand-written rows this
                                                replaced could only ever show a fixed set. */}
                                            {activeProfileTab !== 'bank' && (
                                                <TemplateReadView
                                                    sections={readSectionsFor(activeProfileTab)}
                                                    employee={employee}
                                                    profile={profile}
                                                    emptyLabel={t('notUpdatedYet')}
                                                />
                                            )}


                                            {/* Insurance & tax identifiers, held on the employee
                                                profile rather than the template. */}
                                            {activeProfileTab === 'bank' && (
                                                <div className="space-y-4">
                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                        <div className="p-4 bg-slate-50 rounded-xl">
                                                            <p className="text-xs text-slate-500 mb-1">{t('bankTabTaxId')}</p>
                                                            <p className="text-sm font-semibold text-slate-900">{profile?.taxCode || t('notUpdatedYet')}</p>
                                                        </div>
                                                        <div className="p-4 bg-slate-50 rounded-xl">
                                                            <p className="text-xs text-slate-500 mb-1">{t('bankTabSocialInsurance')}</p>
                                                            <p className="text-sm font-semibold text-slate-900">{profile?.socialInsuranceNumber || t('notUpdatedYet')}</p>
                                                        </div>
                                                        <div className="p-4 bg-slate-50 rounded-xl">
                                                            <p className="text-xs text-slate-500 mb-1">{t('bankTabHealthInsurance')}</p>
                                                            <p className="text-sm font-semibold text-slate-900">{profile?.healthInsuranceNumber || t('notUpdatedYet')}</p>
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </motion.div>
                            )}

                            {/* Documents Section */}
                            {activeSection === 'documents' && (
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="surface-panel p-6"
                                >
                                    <div className="flex items-center justify-between mb-6">
                                        <div>
                                            <h2 className="text-lg font-bold text-primary">{t('documentsHeading')}</h2>
                                            <p className="text-sm text-slate-600 mt-1">
                                                {t('documentsSubheading')}
                                            </p>
                                        </div>
                                        <DocumentUpload
                                            employeeId={id}
                                            onUpload={handleDocumentUpload}
                                            onSuccess={fetchEmployee}
                                        />
                                    </div>
                                    <DocumentList
                                        documents={documents}
                                        onDelete={handleDocumentDelete}
                                        onRefresh={fetchEmployee}
                                    />
                                </motion.div>
                            )}

                            {/* Visa & Work Permit Section */}
                            {activeSection === 'visa' && (
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="surface-panel p-6"
                                >
                                    <VisaSection employeeId={id} canEdit={canManageVisas} />
                                </motion.div>
                            )}

                            {/* Supervisor Section */}
                            {activeSection === 'supervisor' && (
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="surface-panel p-6"
                                >
                                    <SupervisorSection employeeId={id} canEdit={canManageVisas} />
                                </motion.div>
                            )}

                            {/* Salary Structure Section */}
                            {activeSection === 'salary' && canViewSalary && (
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                >
                                    <SalaryStructure employeeId={id} canEdit={canEditProfile} salaryType={employee.salaryType} />
                                </motion.div>
                            )}

                            {/* Rewards & Disciplines Section */}
                            {activeSection === 'rewards' && (
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                >
                                    <EmployeeRewardsAndDisciplines employeeId={id} canEdit={canEditProfile} />
                                </motion.div>
                            )}

                            {/* Activity Section */}
                            {activeSection === 'activity' && (
                                <motion.div
                                    initial={{ opacity: 0, y: 20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="surface-panel p-6"
                                >
                                    <h2 className="text-lg font-bold text-primary mb-6">{t('recentActivityHeading')}</h2>
                                    <ActivityTimeline key={activityRefreshKey} employeeId={id} />
                                </motion.div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Section-scoped profile editor — opened from each tab's "Edit" button.
                    Closes only via X / Cancel so a stray outside-click can't discard edits. */}
                {editSection && (
                    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
                            {/* Header */}
                            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-brand-primary to-brand-primary-dark">
                                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                                    <Edit2 size={18} />
                                    {editSection === 'personal' && tp('personalInfoTab')}
                                    {editSection === 'emergency' && tp('emergencyContactTab')}
                                    {editSection === 'education' && tp('educationTab')}
                                    {editSection === 'bank' && t('bankTabHeading')}
                                </h2>
                                <button
                                    onClick={() => setEditSection(null)}
                                    className="p-1.5 text-white/90 hover:bg-white/20 rounded-lg transition-all"
                                    aria-label={tc('close')}
                                >
                                    <X size={20} />
                                </button>
                            </div>

                            {/* Body */}
                            <div className="p-6 overflow-y-auto">
                                <EmployeeProfileForm
                                    section={editSection}
                                    profile={profile}
                                    disabled={!canEditProfile}
                                    onSave={async (data) => {
                                        await handleProfileSave(data);
                                        setEditSection(null);
                                    }}
                                    onCancel={() => setEditSection(null)}
                                />
                            </div>
                        </div>
                    </div>
                )}
                {/* Overtime Policy Details Modal */}
                <OvertimePolicyModal
                    isOpen={showPolicyModal}
                    onClose={() => setShowPolicyModal(false)}
                    employeeId={id}
                    resolvedPolicy={resolvedPolicy}
                    canEdit={canEditProfile}
                />
            </>
        </ProtectedRoute>
    );
}