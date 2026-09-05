'use client';

import { Employee } from '@/types/employee';
import { Mail, Phone, Calendar, MapPin } from 'lucide-react';
import { motion } from 'framer-motion';
import { formatDate } from '@/utils/formatters';
import Avatar from '@/components/common/Avatar';
import { useTranslations } from 'next-intl';

interface EmployeeCardViewProps {
  employees: Employee[];
  onView: (id: string) => void;
}

export default function EmployeeCardView({ employees, onView }: EmployeeCardViewProps) {
  const t = useTranslations('employeeCardView');
  const tc = useTranslations('common');

  const getStatusColor = (status: string) => {
    const colors = {
      ACTIVE: 'bg-gradient-to-r from-green-400 to-emerald-500 text-white border-green-300 shadow-lg shadow-green-500/30',
      ON_LEAVE: 'bg-gradient-to-r from-amber-400 to-orange-500 text-white border-amber-300 shadow-lg shadow-amber-500/30',
      TERMINATED: 'bg-gradient-to-r from-red-400 to-rose-500 text-white border-red-300 shadow-lg shadow-red-500/30',
    };
    return colors[status as keyof typeof colors] || 'bg-gray-100 text-gray-700 border-gray-200';
  };

  const getStatusLabel = (status: string) => {
    const labels = {
      ACTIVE: tc('active'),
      ON_LEAVE: tc('onLeaveStatus'),
      TERMINATED: tc('terminated'),
    };
    return labels[status as keyof typeof labels] || status;
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {employees.map((employee, index) => (
        <motion.div
          key={employee.id}
          data-testid={`emp-card-${employee.employeeCode}`}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.05 }}
          onClick={() => onView(employee.id)}
          className="bg-white rounded-2xl border-2 border-slate-200 hover:border-brand-primary hover:shadow-2xl hover:scale-105 transition-all duration-300 overflow-hidden cursor-pointer group"
          title={t('clickToSeeDetails')}
        >
          {/* Card Header */}
          <div className="relative h-28 bg-gradient-to-br from-brand-primary via-brand-primary to-indigo-600">
            <div className="absolute inset-0 bg-black/10"></div>
            <div className="absolute -bottom-12 start-4">
              <div className="w-24 h-24 rounded-2xl border-4 border-white shadow-2xl overflow-hidden">
                <Avatar 
                  src={employee.avatarUrl}
                  name={employee.fullName}
                  alt={employee.fullName}
                  className="w-full! h-full! rounded-none! border-0"
                />
              </div>
            </div>
            <div className="absolute top-3 end-3">
              <span className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 ${getStatusColor(employee.status)}`}>
                {getStatusLabel(employee.status)}
              </span>
            </div>
          </div>

          {/* Card Body */}
          <div className="pt-14 px-5 pb-5 space-y-3">
            <div>
              <h3 className="font-bold text-slate-900 text-lg truncate group-hover:text-brand-primary transition-colors">{employee.fullName}</h3>
              <p className="text-sm text-brand-primary font-semibold">{employee.employeeCode}</p>
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-slate-600">
                <div className="w-5 h-5 flex items-center justify-center">
                  <Mail size={14} />
                </div>
                <span className="truncate">{employee.email}</span>
              </div>
              
              {employee.phone && (
                <div className="flex items-center gap-2 text-slate-600">
                  <div className="w-5 h-5 flex items-center justify-center">
                    <Phone size={14} />
                  </div>
                  <span>{employee.phone}</span>
                </div>
              )}

              <div className="flex items-center gap-2 text-slate-600">
                <div className="w-5 h-5 flex items-center justify-center">
                  <MapPin size={14} />
                </div>
                <span className="truncate">{employee.department?.name}</span>
              </div>

              <div className="flex items-center gap-2 text-slate-600">
                <div className="w-5 h-5 flex items-center justify-center">
                  <Calendar size={14} />
                </div>
                <span>{t('joinedOn', { date: formatDate(employee.startDate) })}</span>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100">
              <p className="text-xs text-slate-500 font-medium mb-1">{tc('position')}</p>
              <p className="text-sm font-semibold text-slate-700">{employee.position}</p>
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
