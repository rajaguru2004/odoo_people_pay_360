'use client';

import { apiErrorMessage } from '@/utils/apiError';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Download, TrendingUp, TrendingDown, Info, Calendar } from 'lucide-react';
import GenerateDocumentButton from '@/components/documents/GenerateDocumentButton';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { motion } from 'framer-motion';
import payrollService from '@/services/payrollService';
import systemSettingsService from '@/services/systemSettingsService';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { useTranslations } from 'next-intl';
import { impliedDailyRate, isDailyWage } from '@/utils/payBasis';
import { PayslipLines } from '@/components/payroll/PayslipLines';
import { buildPayslipLines } from '@/utils/payslipLines';

export default function MyPayslipDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const router = useRouter();
    const t = useTranslations('myPayslipDetailPage');
    const tp = useTranslations('payBasis');
    const { id } = use(params);
    const [payslip, setPayslip] = useState<any>(null);
    const [comparison, setComparison] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [labels, setLabels] = useState({
        pf: 'Insurance',
        tax: 'Personal income tax',
        netSalary: 'Net Salary',
    });

    useEffect(() => {
        fetchPayslip();
        fetchLabels();
    }, [id]);

    const fetchLabels = async () => {
        try {
            const res: any = await systemSettingsService.getPublic();
            if (res?.success) {
                const find = (key: string) => res.data[key] ?? '';
                const country = find('payroll_country') || 'IN';
                const customPf = find('payroll_label_pf')?.trim();
                const customTax = find('payroll_label_income_tax')?.trim();
                
                let defaultPf = 'Insurance';
                let defaultTax = 'Personal income tax';
                
                if (country === 'IN') {
                    defaultPf = 'EPF';
                    defaultTax = 'Income Tax / TDS';
                } else if (country === 'US') {
                    defaultPf = 'FICA';
                    defaultTax = 'Federal Tax';
                } else if (country === 'GB') {
                    defaultPf = 'National Insurance';
                    defaultTax = 'Income Tax (PAYE)';
                } else if (country === 'AE') {
                    defaultPf = 'GPSSA';
                    defaultTax = 'Income Tax';
                } else if (country === 'SG') {
                    defaultPf = 'CPF';
                    defaultTax = 'Income Tax';
                } else if (country === 'DE') {
                    defaultPf = 'Social Security';
                    defaultTax = 'Income Tax';
                } else if (country === 'OM') {
                    defaultPf = 'SPF';
                    defaultTax = 'Income Tax';
                }
                
                setLabels({
                    pf: customPf || defaultPf,
                    tax: customTax || defaultTax,
                    netSalary: 'Net Salary',
                });
            }
        } catch (error) {
            console.error('Failed to fetch system setting labels:', error);
        }
    };

    const fetchPayslip = async () => {
        try {
            setLoading(true);
            const response = await payrollService.getMyPayslipDetail(id);
            setPayslip(response.data);

            // Fetch previous month for comparison
            const prevMonth = response.data.payroll.month === 1 ? 12 : response.data.payroll.month - 1;
            const prevYear = response.data.payroll.month === 1 ? response.data.payroll.year - 1 : response.data.payroll.year;

            try {
                const allPayslips = await payrollService.getMyPayslips();
                const prevPayslip = allPayslips.data.find((p: any) =>
                    p.month === prevMonth && p.year === prevYear
                );
                if (prevPayslip) {
                    setComparison(prevPayslip);
                }
            } catch (error) {
                // No previous payslip
            }
        } catch (error) {
            // `alert('Salary slip not found')` was wrong as often as it was
            // right: a 403 on somebody else's payslip, an expired session and a
            // dead API all said the slip did not exist. Show what the server
            // actually said.
            console.error('Failed to fetch payslip:', error);
            alert(apiErrorMessage(error, 'Salary slip not found'));
            router.push('/dashboard/payroll');
        } finally {
            setLoading(false);
        }
    };

    if (loading || !payslip) {
        return (
            <>
                <div className="flex items-center justify-center h-96">
                    <div className="w-8 h-8 border-4 border-brand-primary border-t-transparent rounded-full animate-spin"></div>
                </div>
            </>
        );
    }

    const baseSalary = Number(payslip.baseSalary) || 0;
    const allowances = Number(payslip.allowances) || 0;
    const bonus = Number(payslip.bonus) || 0;
    const overtimePay = Number(payslip.overtimePay) || 0;
    const foodAllowance = Number(payslip.foodAllowance) || 0;
    const deduction = Number(payslip.deduction) || 0;
    const insurance = Number(payslip.insurance) || 0;
    const tax = Number(payslip.tax) || 0;
    const netSalary = Number(payslip.netSalary) || 0;

    // There is no separate attendance deduction to reconstruct: Loss of Pay is
    // already inside `deduction` (the engine stores disciplineDeduction +
    // lopDeduction there). Backing net out to a "pro-rated salary" only ever
    // reproduced baseSalary, and the result was then added to the total again.
    const daily = isDailyWage(payslip.employee?.salaryType);
    const dayRate = daily ? impliedDailyRate(baseSalary, payslip.actualWorkDays) : null;

    const totalIncome = baseSalary + allowances + bonus + overtimePay + foodAllowance;
    const totalDeductions = insurance + tax + deduction;

    // The rows of the two sections. Totals above are deliberately NOT derived
    // from these: the twelve stored columns stay the authoritative money, so
    // switching itemisation on changes the granularity of the labels and never
    // a figure. With no lines on the payslip — every installation until an admin
    // turns the feature on — this returns exactly the rows the page has always
    // shown, which `utils/payslipLines.test.ts` pins as an array equality.
    const payslipGroups = buildPayslipLines(payslip as never, {
        labels,
        daily,
        dayRate,
    });

    return (
        <>
            <div className="space-y-6" data-testid="ess-payslip">
                {/* Header */}
                {/* Stacked on a phone: a 3xl title, a back button and a
                    download button on one row leaves the title ~120px. */}
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="flex items-center gap-3 md:gap-4 min-w-0">
                        <button
                            onClick={() => router.back()}
                            aria-label="Back"
                            className="inline-flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center hover:bg-surface-page rounded-[--radius-button] transition-colors text-text-body"
                        >
                            <ArrowLeft size={20} />
                        </button>
                        <div>
                            <h1 className="text-2xl md:text-3xl font-bold text-text-heading">
                                {daily
                                    ? t('titleDaily', { month: payslip.payroll.month, year: payslip.payroll.year })
                                    : t('titleMonthly', { month: payslip.payroll.month, year: payslip.payroll.year })}
                            </h1>
                            <p className="text-text-muted mt-1">Income details and deductions</p>
                        </div>
                    </div>

                    {/* Was a permanently `disabled` button reading "Coming soon".
                        It now generates a real PDF from the published payslip
                        template, and where the engine is off it says so plainly
                        instead of looking broken. */}
                    <GenerateDocumentButton
                        documentType="PAYSLIP"
                        employeeId={payslip.employeeId}
                        subjectId={payslip.id}
                        params={{ month: payslip.payroll.month, year: payslip.payroll.year }}
                        className="inline-flex h-12 md:h-auto w-full md:w-auto items-center justify-center gap-2 px-4 md:py-2 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark transition-colors disabled:opacity-50 touch-manipulation"
                        data-testid="ess-payslip-download"
                    />
                </div>

                {/* Net Salary Card */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-gradient-to-br from-status-success via-status-success to-status-success/80 rounded-[--radius-card] p-8 text-text-on-brand relative overflow-hidden"
                >
                    <div className="absolute top-0 right-0 w-64 h-64 bg-surface-card/5 rounded-full -translate-y-1/2 translate-x-1/2"></div>
                    <div className="absolute bottom-0 left-0 w-48 h-48 bg-surface-card/5 rounded-full translate-y-1/2 -translate-x-1/2"></div>

                    <div className="relative z-10">
                        <p className="text-text-on-brand/80 mb-2">{labels.netSalary}</p>
                        <p data-testid="payslip-net" data-net={String(payslip.netSalary)} className="text-5xl font-bold mb-4">{formatCurrency(Number(payslip.netSalary))}</p>

                        {comparison && (
                            <div className={`flex items-center gap-2 rounded-[--radius-button] px-4 py-2 w-fit ${Number(payslip.netSalary) > Number(comparison.netSalary)
                                ? 'bg-status-success-bg/20'
                                : 'bg-status-error-bg/20'
                                }`}>
                                {Number(payslip.netSalary) > Number(comparison.netSalary) ? (
                                    <>
                                        <TrendingUp size={20} />
                                        <span>Increase {formatCurrency(Number(payslip.netSalary) - Number(comparison.netSalary))} compared to last month</span>
                                    </>
                                ) : (
                                    <>
                                        <TrendingDown size={20} />
                                        <span>Reduce {formatCurrency(Number(comparison.netSalary) - Number(payslip.netSalary))} compared to last month</span>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </motion.div>

                {/* Summary Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.1 }}
                        className="bg-surface-card rounded-[--radius-card] p-6 border border-status-success/20"
                    >
                        <div className="flex items-center gap-3 mb-2">
                            <div className="w-10 h-10 bg-status-success-bg/40 rounded-[--radius-button] flex items-center justify-center">
                                <CurrencyIcon className="text-status-success" size={20} />
                            </div>
                            <p className="text-sm text-text-muted">Total income</p>
                        </div>
                        <p className="text-2xl font-bold text-status-success">{formatCurrency(totalIncome)}</p>
                    </motion.div>

                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2 }}
                        className="bg-surface-card rounded-[--radius-card] p-6 border border-status-error/20"
                    >
                        <div className="flex items-center gap-3 mb-2">
                            <div className="w-10 h-10 bg-status-error-bg/40 rounded-[--radius-button] flex items-center justify-center">
                                <CurrencyIcon className="text-status-error" size={20} />
                            </div>
                            <p className="text-sm text-text-muted">Total deduction</p>
                        </div>
                        <p className="text-2xl font-bold text-status-error">{formatCurrency(totalDeductions)}</p>
                    </motion.div>

                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.3 }}
                        className="bg-surface-card rounded-[--radius-card] p-6 border border-brand-primary/20"
                    >
                        <div className="flex items-center gap-3 mb-2">
                            <div className="w-10 h-10 bg-brand-primary-light/20 rounded-[--radius-button] flex items-center justify-center">
                                <Calendar className="text-brand-primary" size={20} />
                            </div>
                            <p className="text-sm text-text-muted">{daily ? t('daysPaid') : t('workDay')}</p>
                        </div>
                        <p className="text-2xl font-bold text-brand-primary">
                            {/* A daily-wage worker has no nominal-month denominator. */}
                            {daily ? payslip.actualWorkDays : `${payslip.actualWorkDays}/${payslip.workDays}`}
                        </p>
                    </motion.div>
                </div>

                {/* Detailed Breakdown */}
                <div className="bg-surface-card rounded-[--radius-card] p-6 border border-surface-border">
                    <h3 className="text-lg font-bold mb-6 text-text-heading">Salary details</h3>

                    {/* Income Section */}
                    <div className="mb-6">
                        <h4 className="font-semibold text-status-success mb-3 flex items-center gap-2">
                            <div className="w-1 h-5 bg-status-success rounded"></div>
                            Income
                        </h4>
                        <div className="space-y-2">
                            <PayslipLines
                                rows={payslipGroups.income}
                                tone="success"
                                t={t}
                                formatCurrency={formatCurrency}
                            />
                            <div className="flex justify-between py-3 bg-status-success-bg/20 px-4 rounded-[--radius-button] font-bold mt-2 text-text-heading">
                                <span>Total income</span>
                                <span className="text-status-success">{formatCurrency(totalIncome)}</span>
                            </div>
                        </div>
                    </div>

                    {/* Deduction Section */}
                    <div>
                        <h4 className="font-semibold text-status-error mb-3 flex items-center gap-2">
                            <div className="w-1 h-5 bg-status-error rounded"></div>
                            Deduction
                        </h4>
                        <div className="space-y-2">
                            <PayslipLines
                                rows={payslipGroups.deductions}
                                tone="error"
                                t={t}
                                formatCurrency={formatCurrency}
                            />
                            <div className="flex justify-between py-3 bg-status-error-bg/20 px-4 rounded-[--radius-button] font-bold mt-2 text-text-heading">
                                <span>Total deduction</span>
                                <span className="text-status-error">-{formatCurrency(totalDeductions)}</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Info Box */}
                <div className="bg-brand-primary-light/10 border-l-4 border-brand-primary p-4 rounded-r-[--radius-button]">
                    <div className="flex gap-3">
                        <Info className="text-brand-primary flex-shrink-0 mt-0.5" size={20} />
                        <div className="text-sm text-text-body">
                            <p className="font-semibold mb-2 text-text-heading">{t('usefulInfo')}</p>
                            <ul className="space-y-1 list-disc list-inside">
                                <li>
                                    {daily
                                        ? t('daysPaid') + `: ${payslip.actualWorkDays}`
                                        : t('workDay') + `: ${payslip.actualWorkDays}/${payslip.workDays}`}
                                </li>
                                <li>{daily ? t('infoDaily') : t('infoMonthly')}</li>
                                {payslip.notes && <li>{t('infoNote')}: {payslip.notes}</li>}
                            </ul>
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
}
