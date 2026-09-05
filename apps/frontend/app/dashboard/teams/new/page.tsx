'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Save } from 'lucide-react';
import teamService from '@/services/teamService';
import departmentService from '@/services/departmentService';
import employeeService from '@/services/employeeService';
import { Department } from '@/types/department';
import { Employee } from '@/types/employee';
import { CreateTeamData } from '@/types/team';
import { getApiErrorMessage } from '@/lib/apiError';
import PageActionRow from '@/components/common/PageActionRow';
import { usePageHeader } from '@/hooks/usePageHeader';

export default function NewTeamPage() {
  const router = useRouter();

  // The one heading for this route, rendered by TopHeader.
  usePageHeader('Create new Team', 'Add new team to the system');

  const [departments, setDepartments] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  
  const [formData, setFormData] = useState<CreateTeamData>({
    name: '',
    code: '',
    description: '',
    departmentId: '',
    teamLeadId: '',
    type: 'PERMANENT'
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [deptsRes, empsRes] = await Promise.all([
        departmentService.getAll(),
        employeeService.getAll()
      ]);
      setDepartments(deptsRes.data);
      setEmployees(empsRes.data);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.name || !formData.code || !formData.departmentId) {
      alert('Please fill in all required information');
      return;
    }

    try {
      setLoading(true);
      // The optional fields start as '' and the DTO validates them as UUID /
      // text, so posting the raw form state made "teamLeadId must be a UUID"
      // the answer to every create that did not pick a lead — even though the
      // label says the lead is optional. Empty means absent, not empty.
      await teamService.create({
        ...formData,
        teamLeadId: formData.teamLeadId || undefined,
        description: formData.description || undefined,
      });
      router.push('/dashboard/teams');
    } catch (error: any) {
      console.error('Failed to create team:', error);
      alert(getApiErrorMessage(error, 'Creating a failed team'));
    } finally {
      setLoading(false);
    }
  };

  const availableLeads = employees.filter(emp => 
    emp.departmentId === formData.departmentId && emp.status === 'ACTIVE'
  );

  return (
    <>
      <div className="space-y-6">
        {/* Heading lives in TopHeader via usePageHeader — the back navigation stays here. */}
        <PageActionRow
          onBack={() => router.back()}
        />

        {/* Form */}
        <form onSubmit={handleSubmit} className="bg-surface-card rounded-[--radius-card] border border-surface-border p-6">
          <div className="space-y-6">
            {/* Basic Info */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-text-body mb-2">
                  Team name <span className="text-status-error">*</span>
                </label>
                <input
                  data-testid="team-form-name"
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-4 py-2 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary bg-surface-card text-text-body"
                  placeholder="Backend Team"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-text-body mb-2">
                  Team Code <span className="text-status-error">*</span>
                </label>
                <input
                  data-testid="team-form-code"
                  type="text"
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                  className="w-full px-4 py-2 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary bg-surface-card text-text-body"
                  placeholder="IT-BE"
                  required
                />
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-text-body mb-2">
                Describe
              </label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="w-full px-4 py-2 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary bg-surface-card text-text-body"
                rows={3}
                placeholder="Team description..."
              />
            </div>

            {/* Department & Type */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-text-body mb-2">
                  Departments <span className="text-status-error">*</span>
                </label>
                <select
                  data-testid="team-form-department"
                  value={formData.departmentId}
                  onChange={(e) => setFormData({ ...formData, departmentId: e.target.value, teamLeadId: '' })}
                  className="w-full px-4 py-2 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary bg-surface-card text-text-body"
                  required
                >
                  <option value="">Select department</option>
                  {departments.filter(d => d.isActive).map(dept => (
                    <option key={dept.id} value={dept.id}>{dept.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-text-body mb-2">
                  Team type
                </label>
                <select
                  data-testid="team-form-type"
                  value={formData.type}
                  onChange={(e) => setFormData({ ...formData, type: e.target.value as any })}
                  className="w-full px-4 py-2 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary bg-surface-card text-text-body"
                >
                  <option value="PERMANENT">Permanent</option>
                  <option value="PROJECT">Project</option>
                  <option value="CROSS_FUNCTIONAL">Inter-department</option>
                </select>
              </div>
            </div>

            {/* Team Lead */}
            <div>
              <label className="block text-sm font-medium text-text-body mb-2">
                Team Lead
              </label>
              <select
                data-testid="team-form-lead"
                value={formData.teamLeadId}
                onChange={(e) => setFormData({ ...formData, teamLeadId: e.target.value })}
                className="w-full px-4 py-2 border border-surface-border rounded-[--radius-input] focus:outline-none focus:ring-2 focus:ring-brand-primary bg-surface-card text-text-body"
                disabled={!formData.departmentId}
              >
                <option value="">Select team lead (optional)</option>
                {availableLeads.map(emp => (
                  <option key={emp.id} value={emp.id}>
                    {emp.fullName} - {emp.position}
                  </option>
                ))}
              </select>
              {!formData.departmentId && (
                <p className="text-sm text-text-muted mt-1">Please select your department first</p>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 mt-8 pt-6 border-t border-surface-border">
            <button
              data-testid="team-form-cancel"
              type="button"
              onClick={() => router.back()}
              className="flex-1 px-4 py-2 border border-surface-border rounded-[--radius-button] hover:bg-surface-page transition-colors text-text-body"
            >
              Cancel
            </button>
            <button
              data-testid="team-form-submit"
              type="submit"
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-brand-primary text-text-on-brand rounded-[--radius-button] hover:bg-brand-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save size={18} />
              {loading ? 'Creating...' : 'Create teams'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
