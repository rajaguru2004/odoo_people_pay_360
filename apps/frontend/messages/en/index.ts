import dashboard from './dashboard.json';
import attendance from './attendance.json';
import leaves from './leaves.json';
import employees from './employees.json';
import departments from './departments.json';
import branches from './branches.json';
import contracts from './contracts.json';
import payroll from './payroll.json';
import overtime from './overtime.json';
import projects from './projects.json';
import visas from './visas.json';

// Flat-merged namespaces (sidebar/topHeader/etc already used as useTranslations('sidebar') —
// do NOT nest under 'dashboard'/'attendance'/'leaves'/'employees'/'departments'/'contracts'/'payroll'/'overtime'/'projects' keys, that'd break existing calls).
export default {
  ...dashboard,
  ...attendance,
  ...leaves,
  ...employees,
  ...departments,
  ...branches,
  ...contracts,
  ...payroll,
  ...overtime,
  ...projects,
  ...visas,
} as const;
