'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { UserCheck, Calendar, Clock, Loader2, CheckCircle, AlertCircle, FileText, Search } from 'lucide-react';
import attendanceService from '@/services/attendanceService';
import { apiErrorMessage } from '@/utils/apiError';
import employeeService from '@/services/employeeService';
import { Employee } from '@/types/employee';
import { useBrandingStore } from '@/store/brandingStore';

export default function ManualAttendanceEntry() {
  const t = useTranslations('manualAttendanceEntry');
  const tc = useTranslations('common');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [filteredEmployees, setFilteredEmployees] = useState<Employee[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [loadingEmployees, setLoadingEmployees] = useState(false);

  // Helper: get current local date as YYYY-MM-DD (avoids UTC-date mismatch for IST users)
  const getLocalDateString = (d: Date = new Date()): string => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const { branding } = useBrandingStore();
  const officeStart = branding?.office_start_time || '08:30';
  const officeEnd = branding?.office_end_time || '17:30';

  const [date, setDate] = useState(getLocalDateString());
  const [checkIn, setCheckIn] = useState(officeStart);
  const [checkOut, setCheckOut] = useState(officeEnd);
  const [status, setStatus] = useState('PRESENT');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (branding?.office_start_time) {
      setCheckIn(branding.office_start_time);
    }
    if (branding?.office_end_time) {
      setCheckOut(branding.office_end_time);
    }
  }, [branding?.office_start_time, branding?.office_end_time]);
  
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Handle click outside dropdown to close it
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Fetch employees on mount
  useEffect(() => {
    const fetchEmployees = async () => {
      setLoadingEmployees(true);
      try {
        const response = await employeeService.getAll({ status: 'ACTIVE', limit: 1000 });
        const list = Array.isArray(response.data) ? response.data : (response as any).data?.data || [];
        setEmployees(list);
        setFilteredEmployees(list);
      } catch (err: any) {
        console.error('Failed to fetch employees', err);
      } finally {
        setLoadingEmployees(false);
      }
    };
    fetchEmployees();
  }, []);

  // Filter employees when search query changes
  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredEmployees(employees);
      return;
    }
    const query = searchQuery.toLowerCase();
    const filtered = employees.filter(
      (emp) =>
        emp.fullName.toLowerCase().includes(query) ||
        emp.employeeCode.toLowerCase().includes(query) ||
        (emp.department?.name || '').toLowerCase().includes(query)
    );
    setFilteredEmployees(filtered);
  }, [searchQuery, employees]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedEmployee) {
      setErrorMessage(t('selectEmployeeError'));
      return;
    }
    if (!date) {
      setErrorMessage(t('selectDateError'));
      return;
    }

    const onboardDate = selectedEmployee.startDate?.slice(0, 10);
    if (onboardDate && date < onboardDate) {
      setErrorMessage(
        `Cannot record attendance before the employee's onboarding date (${onboardDate})`,
      );
      return;
    }

    if (status === 'PRESENT' && checkIn && checkOut && checkOut <= checkIn) {
      setErrorMessage(t('timeOrderError'));
      return;
    }

    setSubmitting(true);
    setSuccessMessage(null);
    setErrorMessage(null);

    try {
      const payload: any = {
        employeeId: selectedEmployee.id,
        date,
        status,
        notes: notes.trim() || undefined,
      };

      if (status === 'PRESENT') {
        if (checkIn) payload.checkIn = checkIn;
        if (checkOut) payload.checkOut = checkOut;
      }

      const response = await attendanceService.createManualAttendance(payload);
      
      setSuccessMessage(response.message || t('successMsg'));
      
      // Reset form partially for next entry
      setNotes('');
      // Keep employee or clear? Let's clear selected employee to prevent accidental duplicates
      setSelectedEmployee(null);
      setSearchQuery('');
    } catch (error: any) {
      // Flat rejection shape — see apiErrorMessage. The 409 and the onboarding
      // -date refusal both carry text worth showing.
      setErrorMessage(apiErrorMessage(error, t('failedSave')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative overflow-hidden">
      {/* Background Gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-brand-primary/5 to-brand-primary-light/5 rounded-[--radius-card]" />

      {/* Content */}
      <div className="relative bg-surface-card/85 backdrop-blur-sm rounded-[--radius-card] shadow-lg border border-surface-border p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="relative">
            <div className="absolute inset-0 bg-brand-primary rounded-[--radius-card] blur-md opacity-30" />
            <div className="relative w-12 h-12 bg-gradient-to-br from-brand-primary to-brand-primary-dark rounded-[--radius-card] flex items-center justify-center shadow-lg">
              <UserCheck className="w-6 h-6 text-text-on-brand" />
            </div>
          </div>
          <div>
            <h3 className="text-lg font-bold text-text-heading">{t('title')}</h3>
            <p className="text-sm text-text-body">{t('subtitle')}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Employee Selection */}
          <div className="relative" ref={dropdownRef}>
            <label className="block text-sm font-semibold text-text-heading mb-2">
              {t('selectEmployee')} <span className="text-status-error">*</span>
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 start-0 ps-3.5 flex items-center pointer-events-none">
                <Search className="w-5 h-5 text-text-muted" />
              </span>
              <input
                type="text"
                placeholder={selectedEmployee ? `${selectedEmployee.fullName} (${selectedEmployee.employeeCode})` : t('searchPlaceholder')}
                data-testid="manual-employee-search"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowDropdown(true);
                  if (selectedEmployee) setSelectedEmployee(null);
                }}
                onFocus={() => setShowDropdown(true)}
                className={`w-full ps-11 pe-4 py-2.5 bg-surface-card border rounded-[--radius-input] focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all font-medium ${
                  selectedEmployee ? 'border-status-success text-status-success bg-status-success-bg/20' : 'border-surface-border text-text-body'
                }`}
              />
              {selectedEmployee && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedEmployee(null);
                    setSearchQuery('');
                  }}
                  className="absolute inset-y-0 end-0 pe-3.5 flex items-center text-xs font-bold text-status-error hover:text-status-error/80"
                >
                  {tc('clear')}
                </button>
              )}
            </div>

            {/* Dropdown Menu */}
            {showDropdown && (
              <div className="absolute z-20 w-full mt-1.5 bg-surface-overlay border border-surface-border rounded-[--radius-card] shadow-xl max-h-60 overflow-y-auto custom-scrollbar">
                {loadingEmployees ? (
                  <div className="p-4 text-center text-text-muted flex items-center justify-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-brand-primary" /> {t('loadingEmployees')}
                  </div>
                ) : filteredEmployees.length > 0 ? (
                  filteredEmployees.map((emp) => (
                    <button
                      key={emp.id}
                      type="button"
                      data-testid={`manual-employee-option-${emp.id}`}
                      onClick={() => {
                        setSelectedEmployee(emp);
                        setSearchQuery(`${emp.fullName} (${emp.employeeCode})`);
                        setShowDropdown(false);
                      }}
                      className="w-full text-start px-4 py-3 hover:bg-surface-page transition-colors flex items-center justify-between border-b border-surface-border last:border-0"
                    >
                      <div>
                        <div className="font-bold text-text-heading">{emp.fullName}</div>
                        <div className="text-xs text-text-muted font-medium">
                          {t('codeLabel')} {emp.employeeCode} • {emp.position}
                        </div>
                      </div>
                      <div className="text-xs font-semibold px-2 py-1 bg-surface-page text-text-heading rounded-[--radius-button]">
                        {emp.department?.name || t('noDepartment')}
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="p-4 text-center text-text-muted">{t('noActiveEmployees')}</div>
                )}
              </div>
            )}
          </div>

          {/* Form Fields Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Date Field */}
            <div>
              <label className="block text-sm font-semibold text-text-heading mb-2">
                {tc('date')} <span className="text-status-error">*</span>
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 start-0 ps-3.5 flex items-center pointer-events-none">
                  <Calendar className="w-5 h-5 text-text-muted" />
                </span>
                <input
                  data-testid="manual-date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  min={selectedEmployee?.startDate?.slice(0, 10)}
                  max={getLocalDateString()}
                  className="w-full ps-11 pe-4 py-2.5 bg-surface-card border rounded-[--radius-input] border-surface-border focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all font-medium text-text-body"
                  required
                />
              </div>
            </div>

            {/* Status Field */}
            <div>
              <label className="block text-sm font-semibold text-text-heading mb-2">
                {tc('status')}
              </label>
              <select
                data-testid="manual-status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="w-full px-4 py-2.5 bg-surface-card border rounded-[--radius-input] border-surface-border focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all font-medium text-text-body"
              >
                <option value="PRESENT">{t('statusPresent')}</option>
                <option value="ABSENT">{t('statusAbsent')}</option>
                <option value="LEAVE">{t('statusLeave')}</option>
                <option value="HOLIDAY">{t('statusHoliday')}</option>
              </select>
            </div>

            {/* Check In Time */}
            <div>
              <label className={`block text-sm font-semibold mb-2 ${status !== 'PRESENT' ? 'text-text-muted' : 'text-text-heading'}`}>
                {t('checkInTime')}
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 start-0 ps-3.5 flex items-center pointer-events-none">
                  <Clock className={`w-5 h-5 ${status !== 'PRESENT' ? 'text-text-muted/60' : 'text-text-muted'}`} />
                </span>
                <input
                  data-testid="manual-in"
                  type="time"
                  value={checkIn}
                  onChange={(e) => {
                    setCheckIn(e.target.value);
                    if (checkOut && e.target.value && checkOut <= e.target.value) {
                      setCheckOut('');
                    }
                  }}
                  min="00:01"
                  max="23:58"
                  disabled={status !== 'PRESENT'}
                  className="w-full ps-11 pe-4 py-2.5 bg-surface-card border rounded-[--radius-input] border-surface-border focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all font-medium text-text-body disabled:bg-surface-page disabled:text-text-muted disabled:border-surface-border"
                />
              </div>
              {status === 'PRESENT' && checkIn && (
                <p className="mt-1 text-xs text-text-muted">
                  {t('checkOutMustBeAfter')} <span className="font-semibold text-text-body">{checkIn}</span>
                </p>
              )}
            </div>

            {/* Check Out Time */}
            <div>
              <label className={`block text-sm font-semibold mb-2 ${status !== 'PRESENT' ? 'text-text-muted' : 'text-text-heading'}`}>
                {t('checkOutTime')}
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 start-0 ps-3.5 flex items-center pointer-events-none">
                  <Clock className={`w-5 h-5 ${status !== 'PRESENT' ? 'text-text-muted/60' : 'text-text-muted'}`} />
                </span>
                <input
                  data-testid="manual-out"
                  type="time"
                  value={checkOut}
                  onChange={(e) => setCheckOut(e.target.value)}
                  min={checkIn || '00:01'}
                  max="23:59"
                  disabled={status !== 'PRESENT'}
                  className={`w-full ps-11 pe-4 py-2.5 bg-surface-card border rounded-[--radius-input] focus:ring-2 transition-all font-medium text-text-body disabled:bg-surface-page disabled:text-text-muted disabled:border-surface-border ${
                    status === 'PRESENT' && checkOut && checkIn && checkOut <= checkIn
                      ? 'border-status-error focus:ring-status-error/20 focus:border-status-error'
                      : 'border-surface-border focus:ring-brand-primary/20 focus:border-brand-primary'
                  }`}
                />
              </div>
              {status === 'PRESENT' && checkOut && checkIn && checkOut <= checkIn ? (
                <p className="mt-1 text-xs text-status-error font-medium flex items-center gap-1">
                  <AlertCircle className="w-3 h-3 flex-shrink-0" />
                  {t('mustBeAfter', { time: checkIn })}
                </p>
              ) : status === 'PRESENT' && !checkOut ? (
                <p className="mt-1 text-xs text-text-muted">
                  {t('selectTimeAfterCheckIn')}
                </p>
              ) : null}
            </div>
          </div>

          {/* Notes Area */}
          <div>
            <label className="block text-sm font-semibold text-text-heading mb-2">
              {t('notesLabel')}
            </label>
            <div className="relative">
              <span className="absolute top-3 start-3.5 pointer-events-none">
                <FileText className="w-5 h-5 text-text-muted" />
              </span>
              <textarea
                data-testid="manual-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('notesPlaceholder')}
                rows={2}
                className="w-full ps-11 pe-4 py-2.5 bg-surface-card border rounded-[--radius-input] border-surface-border focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all font-medium text-text-body"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-col sm:flex-row gap-3 pt-2 justify-end">
            <button
              data-testid="manual-submit"
              type="submit"
              disabled={submitting || !selectedEmployee}
              className="px-6 py-3 bg-brand-primary hover:bg-brand-primary-dark text-text-on-brand rounded-[--radius-button] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-semibold shadow-lg hover:shadow-xl transition-all"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin animate-spin-fast" /> {tc('saving')}
                </>
              ) : (
                <>
                  <UserCheck className="w-5 h-5" /> {t('logAttendance')}
                </>
              )}
            </button>
          </div>
        </form>

        {/* Feedback Messages */}
        {successMessage && (
          <div className="mt-4 p-4 bg-status-success-bg border border-status-success/20 rounded-[--radius-card] flex items-center gap-3 text-status-success animate-fadeIn">
            <CheckCircle className="w-5 h-5 text-status-success flex-shrink-0" />
            <span data-testid="manual-success" className="text-sm font-medium">{successMessage}</span>
          </div>
        )}

        {errorMessage && (
          <div className="mt-4 p-4 bg-status-error-bg border border-status-error/20 rounded-[--radius-card] flex items-center gap-3 text-status-error animate-fadeIn">
            <AlertCircle className="w-5 h-5 text-status-error flex-shrink-0" />
            <span data-testid="manual-error" className="text-sm font-medium">{errorMessage}</span>
          </div>
        )}
      </div>
    </div>
  );
}
