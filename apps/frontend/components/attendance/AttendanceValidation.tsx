'use client';

import { useState } from 'react';
import { Calendar, AlertTriangle, CheckCircle, XCircle, Loader2, TrendingUp, Users } from 'lucide-react';
import attendanceService from '@/services/attendanceService';
import { useTranslations } from 'next-intl';

interface ValidationIssue {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string;
  severity: 'ERROR' | 'WARNING';
  type: 'MISSING_DAYS' | 'INCOMPLETE_RECORDS';
  expectedDays?: number;
  actualDays?: number;
  missingDays?: number;
  incompleteRecords?: number;
}

interface ValidationResult {
  month: number;
  year: number;
  totalEmployees: number;
  issuesFound: number;
  issues: ValidationIssue[];
}

export default function AttendanceValidation() {
  const t = useTranslations('attendanceValidation');
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [year, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ValidationResult | null>(null);

  const handleValidate = async () => {
    setLoading(true);
    try {
      const response = await attendanceService.validateAttendance(month, year);
      setResult(response.data);
    } catch (error: any) {
      alert(error.response?.data?.message || t('validationFailed'));
    } finally {
      setLoading(false);
    }
  };

  const getSeverityColor = (severity: string) => {
    return severity === 'ERROR' ? 'text-red-600 bg-red-50 border-red-200' : 'text-yellow-600 bg-yellow-50 border-yellow-200';
  };

  const getSeverityIcon = (severity: string) => {
    return severity === 'ERROR'? ( <XCircle className="w-5 h-5 text-red-600" /> ) : ( <AlertTriangle className="w-5 h-5 text-yellow-600" /> ); }; return ( <div className="relative overflow-hidden"> {/* Background Gradient */} <div className="absolute inset-0 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-2xl" /> {/* Content */} <div className="relative bg-white/80 backdrop-blur-sm rounded-2xl shadow-lg border border-slate-200 p-6"> {/* Header */} <div className="flex items-center gap-3 mb-6"> <div className="related"> <div className="absolute inset-0 bg-brand-primary-light/100 rounded-xl blur-md opacity-30" /> <div className="related w-12 h-12 bg-gradient-to-br from-brand-primary to-brand-primary rounded-xl flex items-center justify-center shadow-lg"> <Calendar className="w-6 h-6 text-white" /> </div> </div> <div> <h3 className="text-lg font-bold text-slate-900">{t('checkAttendanceData')}</h3> <p className="text-sm text-slate-600">{t('detectMissing')}</p> </div> </div> {/* Input Form */} <div className="grid grid-cols-2 gap-3 mb-4"> <div> <label className="block text-sm font-semibold text-slate-700 mb-2"> Month </label> <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="w-full px-4 py-2.5 bg-white border-2 border-slate-200 rounded-xl focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all font-medium" > {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => ( <option key={m} value={m}> {t('monthOption', { number: m })} </option> ))} </select> </div> <div> <label className="block text-sm font-semibold text-slate-700 mb-2"> Year </label> <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-full px-4 py-2.5 bg-white border-2 border-slate-200 rounded-xl focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all font-medium" > {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 2 + i).map((y) => ( <option key={y} value={y}> {y} </option> ))} </select> </div> </div> <button onClick={handleValidate} disabled={loading} className="w-full px-6 py-3 bg-gradient-to-r from-brand-primary to-brand-primary-dark hover:from-brand-primary-dark hover:to-brand-primary-dark text-white rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-semibold shadow-lg hover:shadow-xl transition-all" > {loading ? ( <> <Loader2 className="w-5 h-5 animate-spin" /> {t('checking')} </> ) : ( <> <CheckCircle className="w-5 h-5" /> {t('checkNow')} </> )} </button> {/* Results */} {result && ( <div className="mt-6 space-y-4"> {/* Summary Cards */} <div className="grid grid-cols-3 gap-3"> <div className="relative overflow-hidden bg-gradient-to-br from-slate-50 to-slate-100 rounded-xl p-4 border border-slate-200"> <div className="flex items-center gap-2 mb-2"> <Users className="w-4 h-4 text-slate-600" /> <div className="text-xs font-semibold text-slate-600 uppercase tracking-wide">{t('totalEmployees')}</div> </div> <div className="text-2xl font-bold text-slate-900">{result.totalEmployees}</div> </div> <div className={`related overflow-hidden rounded-xl p-4 border-2 ${result.issuesFound > 0 ?'bg-gradient-to-br from-red-50 to-red-100 border-red-200' : 'bg-gradient-to-br from-green-50 to-green-100 border-green-200'}`}>
                <div className="flex items-center gap-2 mb-2">
                  {result.issuesFound > 0 ? (
                    <AlertTriangle className="w-4 h-4 text-red-600" />
                  ) : (
                    <CheckCircle className="w-4 h-4 text-green-600" />
                  )}
                  <div className={`text-xs font-semibold uppercase tracking-wide ${result.issuesFound > 0 ? 'text-red-600' : 'text-green-600'}`}> {t('issue')} </div> </div> <div className={`text-2xl font-bold ${result.issuesFound > 0 ?'text-red-600' : 'text-green-600'}`}> {result.issuesFound} </div> </div> <div className="relative overflow-hidden bg-gradient-to-br from-blue-50 to-indigo-100 rounded-xl p-4 border-2 border-brand-primary-light/30"> <div className="flex items-center gap-2 mb-2"> <TrendingUp className="w-4 h-4 text-brand-primary" /> <div className="text-xs font-semibold text-brand-primary uppercase tracking-wide">{t('completion')}</div> </div> <div className="text-2xl font-bold text-brand-primary"> {((1 - result.issuesFound / result.totalEmployees) * 100).toFixed(1)}% </div> </div> </div> {/* Issues List */} {result.issuesFound > 0 ? ( <div className="space-y-3"> <h4 className="font-bold text-slate-900 flex items-center gap-2"> <AlertTriangle className="w-4 h-4 text-brand-accent-dark" /> {t('problemDetails', { count: result.issuesFound })} </h4> <div className="space-y-2 max-h-96 overflow-y-auto pe-2 custom-scrollbar"> {result.issues.map((issue, index) => ( <div key={index} className={`related overflow-hidden border-s-4 ${issue.severity ==='ERROR' ? 'border-red-500 bg-red-50/50' : 'border-yellow-500 bg-yellow-50/50'} rounded-lg p-4 shadow-sm hover:shadow-md transition-shadow`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex-shrink-0 mt-0.5">
                          {getSeverityIcon(issue.severity)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="font-bold text-slate-900">{issue.employeeName}</span>
                            <span className="text-sm text-slate-500 font-medium">({issue.employeeCode})</span>
                            <span className={`text-xs px-2 py-1 rounded-full font-semibold border ${getSeverityColor(issue.severity)}`}>
                              {issue.severity}
                            </span>
                          </div>
                          <div className="text-sm text-slate-600 mb-2">
                            📍 {issue.department || t('noDepartmentsYet')}
                          </div>
                          {issue.type === 'MISSING_DAYS'&& ( <div className="text-sm bg-white rounded-lg p-2 border border-slate-200"> <span className="font-semibold text-red-700">{t('missingDate', { count: issue.missingDays ?? 0 })}</span>{' '} <span className="text-slate-700">{t('actualVsExpected', { actual: issue.actualDays ?? 0, expected: issue.expectedDays ?? 0 })}</span> </div> )} {issue.type ==='INCOMPLETE_RECORDS'&& ( <div className="text-sm bg-white rounded-lg p-2 border border-slate-200"> <span className="font-semibold text-yellow-700">{t('incompleteRecords', { count: issue.incompleteRecords ?? 0 })}</span>{' '}
                              <span className="text-slate-700">{t('checkInNoCheckOut')}</span> </div> )} </div> </div> </div> ))} </div> </div> ) : ( <div className="relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-green-100 to-emerald-100 rounded-xl" />
                <div className="relative bg-white/60 backdrop-blur-sm border-2 border-green-300 rounded-xl p-6 text-center shadow-lg">
                  <div className="w-16 h-16 bg-gradient-to-br from-green-500 to-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg">
                    <CheckCircle className="w-8 h-8 text-white" />
                  </div>
                  <h4 className="text-xl font-bold text-green-900 mb-2"> {t('perfectData')} </h4> <p className="text-green-700 font-medium">
                    {t('noProblemsDetected', { month: result.month, year: result.year })}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
