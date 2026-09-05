'use client';

import React, { useEffect, useState } from 'react';
import {
    Mail, Phone, Calendar, Building, Briefcase, MapPin, Edit, Save, X, Clock,
    FileText, User, GraduationCap, Heart, AlertCircle, ChevronDown, ChevronUp, CheckCircle2,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useAuthStore } from '@/store/authStore';
import employeeService from '@/services/employeeService';
import { employeeProfileService } from '@/services/employeeProfileService';
import overtimePolicyService, { PolicyResolution } from '@/services/overtimePolicyService';
import OvertimePolicyModal from '@/components/employees/OvertimePolicyModal';
import { Employee } from '@/types/employee';
import { formatDate } from '@/utils/formatters';
import { usePageHeader } from '@/hooks/usePageHeader';
import Avatar from '@/components/common/Avatar';
import ProfileCompletionBar from '@/components/employees/ProfileCompletionBar';
import DocumentUpload from '@/components/employees/DocumentUpload';
import DocumentList from '@/components/employees/DocumentList';
import PaymentInformationSection from '@/components/profile/PaymentInformationSection';
import WhatsAppOptInSection from '@/components/profile/WhatsAppOptInSection';
import WhatsAppLinkSection from '@/components/profile/WhatsAppLinkSection';
import DiscordLinkSection from '@/components/profile/DiscordLinkSection';
import TelegramLinkSection from '@/components/profile/TelegramLinkSection';
import { toast } from 'sonner';

/**
 * Roles the overtime-policy resolver will answer, mirroring `@Roles(...)` on
 * `overtime-policy.controller.ts`. Kept beside the only call that needs it
 * rather than inferred from the shape of a failure.
 */
const POLICY_READER_ROLES = ['ADMIN', 'HR_MANAGER', 'MANAGER'];

// ── Editable section wrapper ───────────────────────────────────────────────
function Section({
    title, icon: Icon, complete, children, editContent, onSave, saving,
}: {
    title: string;
    icon: React.ElementType;
    complete: boolean;
    children: React.ReactNode;
    editContent: React.ReactNode;
    onSave: () => Promise<void>;
    saving: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState(false);

    const handleSave = async () => {
        await onSave();
        setEditing(false);
    };

    return (
        <div className="bg-surface-card rounded-[--radius-card] border border-surface-border overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center justify-between px-6 py-4 hover:bg-surface-page/50 transition-colors"
            >
                <div className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${complete ? 'bg-green-100' : 'bg-amber-50'}`}>
                        <Icon size={18} className={complete ? 'text-green-600' : 'text-amber-500'} />
                    </div>
                    <span className="font-semibold text-text-heading">{title}</span>
                    {complete
                        ? <CheckCircle2 size={16} className="text-green-500" />
                        : <AlertCircle size={16} className="text-amber-400" />}
                </div>
                {open ? <ChevronUp size={18} className="text-slate-400" /> : <ChevronDown size={18} className="text-slate-400" />}
            </button>

            {open && (
                <div className="px-6 pb-6 border-t border-surface-border">
                    {!editing ? (
                        <>
                            <div className="mt-4">{children}</div>
                            <button
                                onClick={() => setEditing(true)}
                                className="mt-4 flex items-center gap-2 px-4 py-2 text-sm font-medium text-brand-primary border border-brand-primary/30 rounded-lg hover:bg-brand-primary/5 transition-colors"
                            >
                                <Edit size={14} /> Edit
                            </button>
                        </>
                    ) : (
                        <>
                            <div className="mt-4 space-y-4">{editContent}</div>
                            <div className="mt-4 flex gap-2">
                                <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-brand-primary text-white rounded-lg hover:bg-brand-primary-dark transition-colors disabled:opacity-50"
                                >
                                    <Save size={14} /> {saving ? 'Saving…' : 'Save'}
                                </button>
                                <button
                                    onClick={() => setEditing(false)}
                                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium border border-surface-border text-slate-600 rounded-lg hover:bg-surface-page transition-colors"
                                >
                                    <X size={14} /> Cancel
                                </button>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

function Field({ label, value }: { label: string; value?: string | null }) {
    return (
        <div className="flex justify-between items-start py-2.5 border-b border-surface-border-light last:border-0">
            <span className="text-sm text-slate-500 shrink-0 w-44">{label}</span>
            <span className="text-sm font-medium text-text-heading text-right">{value || <span className="text-slate-400 italic">Not filled</span>}</span>
        </div>
    );
}

function TextInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
    return (
        <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
            <input
                type="text"
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full px-3 py-2 border border-surface-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary"
            />
        </div>
    );
}

function SelectInput({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
    return (
        <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
            <select
                value={value}
                onChange={e => onChange(e.target.value)}
                className="w-full px-3 py-2 border border-surface-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary bg-white"
            >
                <option value="">— Select —</option>
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
        </div>
    );
}

// ── Main Page ─────────────────────────────────────────────────────────────
export default function ProfilePage() {
    const { user } = useAuthStore();

    // The one heading for this route, rendered by TopHeader. Declared before the
    // loading/no-employee early returns so the hook order never changes.
    usePageHeader('My Profile', 'Personal Information');

    const [employee, setEmployee] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [documents, setDocuments] = useState<any[]>([]);
    const [completion, setCompletion] = useState(0);
    const [saving, setSaving] = useState(false);

    const employeeId = user?.employeeId || user?.employee?.id;

    // ── Form state for each section ──────────────────────────────────────
    const [emergency, setEmergency] = useState({ emergencyContactName: '', emergencyContactPhone: '', emergencyContactRelationship: '' });
    const [education, setEducation] = useState({ highestEducation: '', major: '', university: '' });
    const [personal, setPersonal] = useState({ maritalStatus: '', nationality: '', placeOfBirth: '' });
    const [basicForm, setBasicForm] = useState({ phone: '', address: '', dateOfBirth: '' });
    const [editingBasic, setEditingBasic] = useState(false);
    const [savingBasic, setSavingBasic] = useState(false);
    const [resolvedPolicy, setResolvedPolicy] = useState<PolicyResolution | null>(null);
    const [showPolicyModal, setShowPolicyModal] = useState(false);

    useEffect(() => {
        if (employeeId) fetchProfile();
    }, [user]);

    const fetchProfile = async () => {
        if (!employeeId) return;
        try {
            setLoading(true);
            const response = await employeeService.getProfile(employeeId);
            const data = response.data;
            setEmployee(data);
            setDocuments((data?.documents ?? []).filter((d: any) => d.documentType !== 'AVATAR'));
            setCompletion(data?.profileCompletionPercentage ?? data?.profile?.profileCompletionPercentage ?? 0);
            setBasicForm({
                phone: data?.phone || '',
                address: data?.address || '',
                dateOfBirth: data?.dateOfBirth ? data.dateOfBirth.split('T')[0] : '',
            });

            // Seed form state from existing profile
            const p = data?.profile;
            if (p) {
                setEmergency({ emergencyContactName: p.emergencyContactName || '', emergencyContactPhone: p.emergencyContactPhone || '', emergencyContactRelationship: p.emergencyContactRelationship || '' });
                setEducation({ highestEducation: p.highestEducation || '', major: p.major || '', university: p.university || '' });
                setPersonal({ maritalStatus: p.maritalStatus || '', nationality: p.nationality || '', placeOfBirth: p.placeOfBirth || '' });
            }

            // `GET /overtime-policies/resolve/:employeeId` is ADMIN / HR_MANAGER
            // / MANAGER. An EMPLOYEE opening their own profile used to fire it
            // anyway and swallow the 403 in a catch — but the request still
            // happened, so the browser console filled with "403 (Forbidden)" on
            // a screen that was working correctly. Swallowing an error is not
            // the same as not causing one.
            //
            // Asking only when the caller may be answered. Deliberately NOT
            // widening the endpoint: who may read an overtime policy is a
            // permissions decision, not a page-loading one.
            if (POLICY_READER_ROLES.includes(user?.role ?? '')) {
                try {
                    const otRes = await overtimePolicyService.resolve(employeeId);
                    if (otRes?.data) setResolvedPolicy(otRes.data);
                } catch (e) {
                    // Still guarded: a legacy record can 404 here.
                }
            }
        } catch (err) {
            console.error('Failed to fetch profile:', err);
        } finally {
            setLoading(false);
        }
    };

    const saveBasicInfo = async () => {
        if (!employeeId) return;
        const todayStr = new Date().toISOString().split('T')[0];
        if (basicForm.dateOfBirth && basicForm.dateOfBirth > todayStr) {
            toast.error('Date of Birth cannot be a future date.');
            return;
        }
        setSavingBasic(true);
        try {
            await employeeService.update(employeeId, basicForm as any);
            await fetchProfile();
            setEditingBasic(false);
            toast.success('Basic info updated');
        } catch (err: any) {
            toast.error(err?.message || 'Failed to save');
        } finally {
            setSavingBasic(false);
        }
    };

    const saveSection = async (data: Record<string, string>) => {
        if (!employeeId) return;
        setSaving(true);
        try {
            await employeeProfileService.updateProfile(employeeId, data as any);
            await fetchProfile();
            toast.success('Section saved successfully');
        } catch (err: any) {
            toast.error(err?.message || 'Failed to save');
            throw err;
        } finally {
            setSaving(false);
        }
    };

    const handleDocumentUpload = async (file: File, documentType: string, description?: string) => {
        if (!employeeId) return;
        await employeeProfileService.uploadDocument(employeeId, file, documentType, description);
        await fetchProfile();
    };

    const handleDocumentDelete = async (documentId: string) => {
        if (!employeeId) return;
        await employeeProfileService.deleteDocument(employeeId, documentId);
        await fetchProfile();
    };

    const completionColor = completion >= 80 ? 'text-green-600' : completion >= 50 ? 'text-yellow-600' : 'text-red-500';

    // ── Section completion booleans ──────────────────────────────────────
    const p = employee?.profile;
    const basicComplete = !!(employee?.phone && employee?.address && employee?.gender);
    const emergencyComplete = !!(p?.emergencyContactName && p?.emergencyContactPhone && p?.emergencyContactRelationship);
    const educationComplete = !!(p?.highestEducation && p?.major && p?.university);
    const bankComplete = !!(p?.bankName && p?.bankAccountNumber && p?.bankBranch);
    const personalComplete = !!(p?.maritalStatus && p?.nationality);
    const docsComplete = documents.some(d => d.documentType === 'Resume/CV' || d.documentType === 'RESUME') &&
        documents.some(d => d.documentType === 'ID Card Front' || d.documentType === 'ID_CARD_FRONT');

    if (loading) {
        return (
            <div className="animate-pulse space-y-6">
                <div className="h-11 md:h-8 bg-slate-200 rounded w-48" />
                <div className="h-64 bg-slate-100 rounded-[--radius-card]" />
                <div className="h-20 bg-slate-100 rounded-[--radius-card]" />
            </div>
        );
    }

    if (!employee) return null;

    return (
        <div className="space-y-6" data-testid="ess-profile">
            {/* Top profile card */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                className="bg-surface-card rounded-[--radius-card] border border-surface-border">
                <div className="bg-linear-to-r from-brand-primary to-brand-primary-dark p-4 md:p-8 rounded-t-2xl">
                    <div className="flex items-center gap-4 md:gap-6">
                        <div className="w-16 h-16 md:w-24 md:h-24 shrink-0 rounded-[--radius-card] border-4 border-white shadow-lg overflow-hidden bg-surface-card">
                            <Avatar src={employee.avatarUrl} name={employee.fullName} alt={employee.fullName} className="w-full! h-full! rounded-none! border-0" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-bold text-white">{employee.fullName}</h2>
                            <p className="text-brand-primary-light text-lg mt-1">{employee.position}</p>
                            <div className="flex items-center gap-4 mt-2">
                                <span className="px-3 py-1 bg-surface-card/20 backdrop-blur-sm rounded-[--radius-badge] text-sm text-white">{employee.employeeCode}</span>
                                <span className={`px-3 py-1 rounded-[--radius-badge] text-sm ${employee.status === 'ACTIVE' ? 'bg-status-success-bg0 text-white' : 'bg-status-error text-white'}`}>
                                    {employee.status === 'ACTIVE' ? 'Active' : employee.status === 'ON_LEAVE' ? 'On break' : 'Terminated'}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="p-8 space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* Email — read-only */}
                        <div className="flex items-start gap-4">
                            <div className="w-12 h-12 bg-status-info-bg rounded-[--radius-card] flex items-center justify-center shrink-0">
                                <Mail className="text-status-info" size={24} />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm text-slate-500 mb-1">Email</p>
                                <p className="text-base font-semibold text-text-heading">{employee.email}</p>
                            </div>
                        </div>

                        {/* Phone — editable */}
                        <div className="flex items-start gap-4">
                            <div className="w-12 h-12 bg-status-success-bg rounded-[--radius-card] flex items-center justify-center shrink-0">
                                <Phone className="text-status-success" size={24} />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm text-slate-500 mb-1">Phone</p>
                                {editingBasic
                                    ? <input type="tel" value={basicForm.phone} onChange={e => setBasicForm(f => ({ ...f, phone: e.target.value }))}
                                        className="w-full px-3 py-2.5 md:py-1.5 border border-surface-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary" placeholder="e.g. 0912345678" />
                                    : <p className="text-base font-semibold text-text-heading">{employee.phone || <span className="text-slate-400 italic text-sm">Not filled</span>}</p>}
                            </div>
                        </div>

                        {/* Date of Birth — editable */}
                        <div className="flex items-start gap-4">
                            <div className="w-12 h-12 bg-brand-primary-light/20 rounded-[--radius-card] flex items-center justify-center shrink-0">
                                <Calendar className="text-brand-primary" size={24} />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm text-slate-500 mb-1">Date of Birth</p>
                                {editingBasic
                                    ? <input type="date" value={basicForm.dateOfBirth} max={new Date().toISOString().split('T')[0]} onChange={e => setBasicForm(f => ({ ...f, dateOfBirth: e.target.value }))}
                                        className="w-full px-3 py-2.5 md:py-1.5 border border-surface-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary" />
                                    : <p className="text-base font-semibold text-text-heading">{formatDate(employee.dateOfBirth)}</p>}
                            </div>
                        </div>

                        {/* Department — read-only */}
                        <div className="flex items-start gap-4">
                            <div className="w-12 h-12 bg-brand-primary/10 rounded-[--radius-card] flex items-center justify-center shrink-0">
                                <Building className="text-brand-primary" size={24} />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm text-slate-500 mb-1">Department</p>
                                <p className="text-base font-semibold text-text-heading">{employee.department?.name}</p>
                            </div>
                        </div>

                        {/* Position — read-only */}
                        <div className="flex items-start gap-4">
                            <div className="w-12 h-12 bg-brand-accent/10 rounded-[--radius-card] flex items-center justify-center shrink-0">
                                <Briefcase className="text-text-heading" size={24} />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm text-slate-500 mb-1">Position</p>
                                <p className="text-base font-semibold text-text-heading">{employee.position}</p>
                            </div>
                        </div>

                        {/* Hire Date — read-only */}
                        <div className="flex items-start gap-4">
                            <div className="w-12 h-12 bg-status-warning-bg rounded-[--radius-card] flex items-center justify-center shrink-0">
                                <Calendar className="text-status-warning" size={24} />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm text-slate-500 mb-1">Hire Date</p>
                                <p className="text-base font-semibold text-text-heading">{formatDate(employee.startDate)}</p>
                            </div>
                        </div>

                        {/* Overtime Policy — read-only */}
                        <div className="flex items-start gap-4">
                            <div className="w-12 h-12 bg-purple-500/10 rounded-[--radius-card] flex items-center justify-center shrink-0">
                                <Clock className="text-purple-600" size={24} />
                            </div>
                            <div className="flex-1">
                                <div className="flex items-center justify-between">
                                    <p className="text-sm text-slate-500 mb-1">Overtime Policy</p>
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
                                <div className="flex items-center justify-between">
                                    <p className="text-base font-semibold text-text-heading">
                                        {resolvedPolicy?.effectivePolicyName || 'Company Default Policy'}
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => setShowPolicyModal(true)}
                                        className="text-xs font-semibold text-brand-primary hover:underline ml-2"
                                    >
                                        View Details
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Address — editable, full width */}
                    <div className="flex items-start gap-4">
                        <div className="w-12 h-12 bg-brand-accent/10 rounded-[--radius-card] flex items-center justify-center shrink-0">
                            <MapPin className="text-brand-accent" size={24} />
                        </div>
                        <div className="flex-1">
                            <p className="text-sm text-slate-500 mb-1">Address</p>
                            {editingBasic
                                ? <input type="text" value={basicForm.address} onChange={e => setBasicForm(f => ({ ...f, address: e.target.value }))}
                                    className="w-full px-3 py-2.5 md:py-1.5 border border-surface-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary" placeholder="e.g. 123 Main Street, Ho Chi Minh City" />
                                : <p className="text-base font-semibold text-text-heading">{employee.address || <span className="text-slate-400 italic text-sm">Not filled</span>}</p>}
                        </div>
                    </div>

                    {/* Edit / Save / Cancel buttons */}
                    <div className="flex gap-2">
                        {!editingBasic ? (
                            <button onClick={() => setEditingBasic(true)}
                                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-brand-primary border border-brand-primary/30 rounded-lg hover:bg-brand-primary/5 transition-colors">
                                <Edit size={14} /> Edit contact info
                            </button>
                        ) : (
                            <>
                                <button onClick={saveBasicInfo} disabled={savingBasic}
                                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-brand-primary text-white rounded-lg hover:bg-brand-primary-dark transition-colors disabled:opacity-50">
                                    <Save size={14} /> {savingBasic ? 'Saving…' : 'Save'}
                                </button>
                                <button onClick={() => { setEditingBasic(false); setBasicForm({ phone: employee.phone || '', address: employee.address || '', dateOfBirth: employee.dateOfBirth ? employee.dateOfBirth.split('T')[0] : '' }); }}
                                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium border border-surface-border text-slate-600 rounded-lg hover:bg-surface-page transition-colors">
                                    <X size={14} /> Cancel
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </motion.div>

            {/* Profile Completion */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}
                className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h3 className="text-lg font-bold text-text-heading">Profile Completion</h3>
                        <p className="text-sm text-slate-500 mt-0.5">Complete all sections so HR can manage your records properly</p>
                    </div>
                    <span className={`text-3xl font-bold ${completionColor}`}>{completion}%</span>
                </div>
                <ProfileCompletionBar percentage={completion} />

                {/* Section checklist */}
                <div className="mt-5 grid grid-cols-2 md:grid-cols-3 gap-3">
                    {[
                        { label: 'Basic Info', done: basicComplete, detail: 'Phone, address, gender' },
                        { label: 'Personal Info', done: personalComplete, detail: 'Marital status, nationality' },
                        { label: 'Emergency Contact', done: emergencyComplete, detail: 'Name, phone, relationship' },
                        { label: 'Education', done: educationComplete, detail: 'Degree, major, university' },
                        { label: 'Bank Info', done: bankComplete, detail: 'Bank name & account number' },
                        { label: 'Documents', done: docsComplete, detail: 'Resume + ID Card Front' },
                    ].map(s => (
                        <div key={s.label} className={`flex items-start gap-2 p-3 rounded-xl border ${s.done ? 'border-green-200 bg-green-50' : 'border-amber-200 bg-amber-50'}`}>
                            {s.done
                                ? <CheckCircle2 size={16} className="text-green-500 shrink-0 mt-0.5" />
                                : <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />}
                            <div>
                                <p className={`text-xs font-semibold ${s.done ? 'text-green-700' : 'text-amber-700'}`}>{s.label}</p>
                                <p className="text-xs text-slate-500 mt-0.5">{s.done ? 'Complete' : s.detail}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </motion.div>

            {/* Editable Sections */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="space-y-3">
                <h3 className="text-base font-semibold text-slate-600 px-1">Complete your profile — click a section to expand and edit</h3>

                {/* Personal Info */}
                <Section
                    title="Personal Information"
                    icon={User}
                    complete={personalComplete}
                    onSave={() => saveSection(personal)}
                    saving={saving}
                    children={
                        <div className="space-y-1">
                            <Field label="Marital Status" value={p?.maritalStatus} />
                            <Field label="Nationality" value={p?.nationality} />
                            <Field label="Place of Birth" value={p?.placeOfBirth} />
                            <Field label="Gender" value={employee.gender} />
                            <Field label="ID Card" value={employee.idCard} />
                        </div>
                    }
                    editContent={
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <SelectInput label="Marital Status" value={personal.maritalStatus} onChange={v => setPersonal(s => ({ ...s, maritalStatus: v }))}
                                options={[{ value: 'SINGLE', label: 'Single' }, { value: 'MARRIED', label: 'Married' }, { value: 'DIVORCED', label: 'Divorced' }, { value: 'WIDOWED', label: 'Widowed' }]} />
                            <TextInput label="Nationality" value={personal.nationality} onChange={v => setPersonal(s => ({ ...s, nationality: v }))} placeholder="e.g. Indian" />
                            <TextInput label="Place of Birth" value={personal.placeOfBirth} onChange={v => setPersonal(s => ({ ...s, placeOfBirth: v }))} placeholder="City, Country" />
                        </div>
                    }
                />

                {/* Emergency Contact */}
                <Section
                    title="Emergency Contact"
                    icon={Heart}
                    complete={emergencyComplete}
                    onSave={() => saveSection(emergency)}
                    saving={saving}
                    children={
                        <div className="space-y-1">
                            <Field label="Name" value={p?.emergencyContactName} />
                            <Field label="Phone" value={p?.emergencyContactPhone} />
                            <Field label="Relationship" value={p?.emergencyContactRelationship} />
                        </div>
                    }
                    editContent={
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <TextInput label="Full Name" value={emergency.emergencyContactName} onChange={v => setEmergency(s => ({ ...s, emergencyContactName: v }))} placeholder="e.g. Nguyen Van A" />
                            <TextInput label="Phone Number" value={emergency.emergencyContactPhone} onChange={v => setEmergency(s => ({ ...s, emergencyContactPhone: v }))} placeholder="e.g. 0912345678" />
                            <SelectInput label="Relationship" value={emergency.emergencyContactRelationship} onChange={v => setEmergency(s => ({ ...s, emergencyContactRelationship: v }))}
                                options={[{ value: 'Spouse', label: 'Spouse' }, { value: 'Parent', label: 'Parent' }, { value: 'Sibling', label: 'Sibling' }, { value: 'Child', label: 'Child' }, { value: 'Friend', label: 'Friend' }, { value: 'Other', label: 'Other' }]} />
                        </div>
                    }
                />

                {/* Education */}
                <Section
                    title="Education"
                    icon={GraduationCap}
                    complete={educationComplete}
                    onSave={() => saveSection(education)}
                    saving={saving}
                    children={
                        <div className="space-y-1">
                            <Field label="Highest Education" value={p?.highestEducation} />
                            <Field label="Major / Field" value={p?.major} />
                            <Field label="University / School" value={p?.university} />
                        </div>
                    }
                    editContent={
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <SelectInput label="Highest Education" value={education.highestEducation} onChange={v => setEducation(s => ({ ...s, highestEducation: v }))}
                                options={[{ value: 'HIGH_SCHOOL', label: 'High School' }, { value: 'ASSOCIATE', label: 'Associate' }, { value: 'BACHELOR', label: "Bachelor's" }, { value: 'MASTER', label: "Master's" }, { value: 'PHD', label: 'PhD' }]} />
                            <TextInput label="Major / Field of Study" value={education.major} onChange={v => setEducation(s => ({ ...s, major: v }))} placeholder="e.g. Computer Science" />
                            <TextInput label="University / School" value={education.university} onChange={v => setEducation(s => ({ ...s, university: v }))} placeholder="e.g. Hanoi University" />
                        </div>
                    }
                />

                {/* Payment Information — bank details via approval workflow */}
                <PaymentInformationSection />

                {/* WhatsApp notification opt-in (anchor: /dashboard/profile#notifications) */}
                <WhatsAppOptInSection />
                <WhatsAppLinkSection />

                {/* Discord account link (anchor: /dashboard/profile#discord).
                    Renders nothing unless the channel and employee linking are both on. */}
                <DiscordLinkSection />

                {/* Telegram account link (anchor: /dashboard/profile#telegram).
                    Renders nothing unless the channel, employee linking and the
                    inbound webhook are all on — the code is redeemed on that
                    webhook, so with it off there is nothing to redeem against. */}
                <TelegramLinkSection />
            </motion.div>

            {/* Documents */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
                className="bg-surface-card rounded-[--radius-card] border border-surface-border">
                <div className="px-6 py-4 border-b border-surface-border flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${docsComplete ? 'bg-green-100' : 'bg-amber-50'}`}>
                            <FileText size={18} className={docsComplete ? 'text-green-600' : 'text-amber-500'} />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h3 className="font-semibold text-text-heading">My Documents</h3>
                                {docsComplete
                                    ? <CheckCircle2 size={15} className="text-green-500" />
                                    : <AlertCircle size={15} className="text-amber-400" />}
                            </div>
                            <p className="text-xs text-slate-500">
                                {documents.length} uploaded{!docsComplete && ' — Resume & ID Card Front required'}
                            </p>
                        </div>
                    </div>
                    {employeeId && (
                        <DocumentUpload employeeId={employeeId} onUpload={handleDocumentUpload} onSuccess={fetchProfile} />
                    )}
                </div>

                <div className="p-6">
                    {documents.length === 0 ? (
                        <div className="text-center py-10">
                            <div className="w-16 h-16 bg-amber-50 rounded-full flex items-center justify-center mx-auto mb-4">
                                <FileText size={32} className="text-amber-400" />
                            </div>
                            <p className="text-slate-600 font-medium mb-1">No documents uploaded yet</p>
                            <p className="text-sm text-slate-400 max-w-sm mx-auto">
                                Upload your <strong>Resume/CV</strong> and <strong>ID Card Front</strong> to earn the 10% document completion and meet HR requirements.
                            </p>
                        </div>
                    ) : (
                        <DocumentList documents={documents} onDelete={handleDocumentDelete} onRefresh={fetchProfile} />
                    )}
                </div>
            </motion.div>
            {/* Overtime Policy Details Modal */}
            <OvertimePolicyModal
                isOpen={showPolicyModal}
                onClose={() => setShowPolicyModal(false)}
                employeeId={employeeId || ''}
                resolvedPolicy={resolvedPolicy}
                canEdit={['ADMIN', 'HR_MANAGER'].includes(user?.role || '')}
            />
        </div>
    );
}
