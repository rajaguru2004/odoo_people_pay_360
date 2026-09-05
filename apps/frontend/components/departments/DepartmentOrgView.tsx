'use client';

import { useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import ReactFlow, {
  Node,
  Edge,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
  Position,
  Handle,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Department } from '@/types/department';
import { Team } from '@/types/team';
import { Building2, Users, User, Crown } from 'lucide-react';
import { activeTheme } from '@/theme';

interface DepartmentOrgViewProps {
  departments: Department[];
  teams?: Team[];
  onView: (id: string) => void;
}

// Custom Node Component for Department
function DepartmentNode({ data }: any) {
  const { department, level, onClick } = data;
  const isCEO = level === 0;
  const t = useTranslations('departmentOrgView');

  return (
    <div
      onClick={() => onClick(department.id)}
      className={`cursor-pointer transition-all hover:scale-105 ${
        isCEO ? 'w-80' : level === 1 ? 'w-72' : 'w-64'
      }`}
    >
      {/* Input Handle (top) */}
      <Handle
        type="target"
        position={Position.Top}
        style={{
          background: isCEO ? activeTheme.colors.brandAccent : level === 1 ? activeTheme.colors.brandPrimary : activeTheme.colors.brandPrimaryLight,
          width: 14,
          height: 14,
          border: '3px solid white',
          boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
        }}
      />
      
      <div className={`relative bg-surface-card rounded-[--radius-card] border-2 shadow-2xl overflow-hidden ${
        isCEO
          ? 'border-brand-accent shadow-brand-accent/30'
          : level === 1
          ? 'border-brand-primary shadow-brand-primary/20'
          : 'border-brand-primary-light shadow-brand-primary/10'
      }`}>
        {/* Gradient overlay */}
        <div className={`absolute inset-0 opacity-40 ${
          isCEO
            ? 'bg-gradient-to-br from-brand-accent/20 via-brand-accent/5 to-surface-card'
            : level === 1
            ? 'bg-gradient-to-br from-brand-primary/10 via-brand-primary/5 to-surface-card'
            : 'bg-gradient-to-br from-brand-primary-light/10 via-brand-primary-light/5 to-surface-card'
        }`}></div>
        
        {/* Decorative corner accent */}
        <div className={`absolute top-0 end-0 w-24 h-24 opacity-20 ${
          isCEO
            ? 'bg-gradient-to-bl from-brand-accent to-transparent'
            : level === 1
            ? 'bg-gradient-to-bl from-brand-primary to-transparent'
            : 'bg-gradient-to-bl from-brand-primary-light to-transparent'
        }`}></div>

        <div className="relative p-5">
          <div className="flex items-start gap-3 mb-3">
            <div className={`w-14 h-14 rounded-[--radius-card] bg-gradient-to-br flex items-center justify-center shadow-xl relative overflow-hidden ${
              isCEO
                ? 'from-brand-accent to-brand-accent-dark shadow-brand-accent/50'
                : level === 1
                ? 'from-brand-primary to-brand-primary-dark shadow-brand-primary/40'
                : 'from-brand-primary-light to-brand-primary shadow-brand-primary-light/30'
            }`}>
              {/* Shine effect */}
              <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/20 to-transparent"></div>
              {isCEO ? (
                <Crown className="text-text-on-brand" size={28} />
              ) : (
                <Building2 className="text-text-on-brand" size={24} />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <h4 className={`font-bold text-text-heading ${
                isCEO ? 'text-xl' : level === 1 ? 'text-lg' : 'text-base'
              }`}>
                {department.name}
              </h4>
              <p className="text-xs text-text-muted font-semibold mt-0.5">{department.code}</p>
              {isCEO && (
                <div className="mt-2 inline-block px-3 py-1.5 bg-gradient-to-r from-brand-accent to-brand-accent-dark text-text-on-accent text-xs font-bold rounded-[--radius-badge] shadow-lg shadow-brand-accent/30 border border-white/20">
                  {t('boardOfDirectors')}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-accent/10 rounded-[--radius-card] border border-brand-accent/30 shadow-sm">
              <Users size={14} className="text-brand-accent" />
              <span className="text-xs font-bold text-brand-accent">{department._count?.employees || 0}</span>
            </div>
            {department._count?.children > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-primary-light/20 rounded-[--radius-card] border border-brand-primary/30 shadow-sm">
                <Building2 size={14} className="text-brand-primary" />
                <span className="text-xs font-bold text-brand-primary">{department._count.children}</span>
              </div>
            )}
          </div>

          {department.manager ? (
            <div className="pt-3 border-t border-surface-border-light">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-primary to-brand-primary-dark flex items-center justify-center text-text-on-brand font-bold text-xs shadow-lg shadow-brand-primary/30 border-2 border-white">
                  {department.manager.fullName.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-text-body truncate">{department.manager.fullName}</p>
                  <p className="text-[10px] text-text-muted truncate font-medium">{department.manager.position}</p>
                </div>
                <User size={12} className="text-brand-primary/60" />
              </div>
            </div>
          ) : (
            <div className="pt-3 border-t border-surface-border-light">
              <div className="flex items-center gap-2 text-status-warning bg-status-warning-bg/30 px-2 py-1.5 rounded-[--radius-card] border border-status-warning/20">
                <div className="w-2 h-2 rounded-full bg-status-warning animate-pulse shadow-sm"></div>
                <span className="text-xs font-medium">{t('noManagementYet')}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Output Handle (bottom) */}
      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          background: isCEO ? activeTheme.colors.brandAccent : level === 1 ? activeTheme.colors.brandPrimary : activeTheme.colors.brandPrimaryLight,
          width: 14,
          height: 14,
          border: '3px solid white',
          boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
        }}
      />
    </div>
  );
}

// Custom Node Component for Team
function TeamNode({ data }: any) {
  const { team, onClick } = data;
  const t = useTranslations('departmentOrgView');

  return (
    <div
      onClick={() => onClick(team.id)}
      className="cursor-pointer transition-all hover:scale-105 w-56"
    >
      {/* Input Handle (top) */}
      <Handle
        type="target"
        position={Position.Top}
        style={{
          background: activeTheme.colors.brandAccent,
          width: 12,
          height: 12,
          border: '3px solid white',
          boxShadow: `0 2px 10px ${activeTheme.colors.brandAccent}40`,
        }}
      />
      
      <div className="relative bg-surface-card rounded-[--radius-card] border-2 border-brand-accent shadow-2xl shadow-brand-accent/20 overflow-hidden">
        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-br from-brand-accent/10 via-brand-accent/5 to-surface-card opacity-50"></div>
        {/* Decorative corner accent */}
        <div className="absolute top-0 end-0 w-20 h-20 bg-gradient-to-bl from-brand-accent/20 to-transparent opacity-40"></div>
        
        <div className="relative p-4">
          <div className="flex items-start gap-3 mb-3">
            <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-brand-accent to-brand-accent-dark flex items-center justify-center shadow-xl shadow-brand-accent/30 relative overflow-hidden">
              {/* Shine effect */}
              <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/20 to-transparent"></div>
              <Users className="text-text-on-accent relative z-10" size={20} />
            </div>
            
            <div className="flex-1 min-w-0">
              <h4 className="font-bold text-sm text-text-heading">
                {team.name}
              </h4>
              <p className="text-xs text-text-muted font-semibold mt-0.5">{team.code}</p>
              <div className="mt-1 inline-block px-2.5 py-1 bg-gradient-to-r from-brand-accent to-brand-accent-dark text-text-on-accent text-[10px] font-bold rounded-[--radius-badge] shadow-md shadow-brand-accent/30 border border-white/20">
                {t('teamBadge')}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 mb-3">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-brand-accent/10 rounded-[--radius-card] border border-brand-accent/30 shadow-sm">
              <Users size={12} className="text-brand-accent" />
              <span className="text-xs font-bold text-brand-accent">{team._count?.members || 0}</span>
            </div>
          </div>

          {team.teamLead ? (
            <div className="pt-3 border-t border-surface-border-light">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand-accent to-brand-accent-dark flex items-center justify-center text-text-on-accent font-bold text-xs shadow-lg shadow-brand-accent/30 border-2 border-white">
                  {team.teamLead.fullName.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-text-body truncate">{team.teamLead.fullName}</p>
                  <p className="text-[10px] text-text-muted font-medium">{t('teamLead')}</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="pt-3 border-t border-surface-border-light">
              <div className="flex items-center gap-2 text-status-warning bg-status-warning-bg/30 px-2 py-1.5 rounded-[--radius-card] border border-status-warning/20">
                <div className="w-2 h-2 rounded-full bg-status-warning animate-pulse shadow-sm"></div>
                <span className="text-xs font-medium">{t('noLeadsYet')}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const nodeTypes = {
  department: DepartmentNode,
  team: TeamNode,
};

export default function DepartmentOrgView({ departments, teams = [], onView }: DepartmentOrgViewProps) {
  const t = useTranslations('departmentOrgView');
  const handleViewTeam = useCallback((teamId: string) => {
    window.location.href = `/dashboard/teams/${teamId}`;
  }, []);

  // Build nodes and edges
  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    
    // Find root department (CEO)
    const rootDept = departments.find(d => d.parentId === null);
    
    if (!rootDept) {
      return { nodes: [], edges: [] };
    }

    // Layout configuration - increased spacing to prevent overlap
    const HORIZONTAL_SPACING = 450;
    const VERTICAL_SPACING = 300;
    const TEAM_VERTICAL_SPACING = 250;
    const TEAM_HORIZONTAL_SPACING = 320;
    
    // Add CEO node at top center
    nodes.push({
      id: rootDept.id,
      type: 'department',
      position: { x: 0, y: 0 },
      data: { 
        department: rootDept, 
        level: 0,
        onClick: onView,
      },
    });

    // Get child departments
    const childDepts = departments.filter(d => d.parentId === rootDept.id);
    const totalChildren = childDepts.length;
    
    // Calculate starting X position to center children
    const startX = -(totalChildren - 1) * HORIZONTAL_SPACING / 2;

    // Add child department nodes
    childDepts.forEach((dept, index) => {
      const x = startX + index * HORIZONTAL_SPACING;
      const y = VERTICAL_SPACING;
      
      nodes.push({
        id: dept.id,
        type: 'department',
        position: { x, y },
        data: { 
          department: dept, 
          level: 1,
          onClick: onView,
        },
      });

      // Add edge from CEO to department
      edges.push({
        id: `e-${rootDept.id}-${dept.id}`,
        source: rootDept.id,
        target: dept.id,
        type: 'smoothstep',
        animated: false,
        style: { 
          stroke: activeTheme.colors.brandPrimary,
          strokeWidth: 4,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: activeTheme.colors.brandPrimary,
          width: 24,
          height: 24,
        },
      });

      // Add teams for this department
      const deptTeams = teams.filter(t => t.departmentId === dept.id);
      const totalTeams = deptTeams.length;
      
      if (totalTeams > 0) {
        const teamStartX = x - (totalTeams - 1) * TEAM_HORIZONTAL_SPACING / 2;
        
        deptTeams.forEach((team, teamIndex) => {
          const teamX = teamStartX + teamIndex * TEAM_HORIZONTAL_SPACING;
          const teamY = y + TEAM_VERTICAL_SPACING;
          
          nodes.push({
            id: team.id,
            type: 'team',
            position: { x: teamX, y: teamY },
            data: { 
              team,
              onClick: handleViewTeam,
            },
          });

          // Add edge from department to team
          edges.push({
            id: `e-${dept.id}-${team.id}`,
            source: dept.id,
            target: team.id,
            type: 'smoothstep',
            animated: false,
            style: { 
              stroke: activeTheme.colors.brandAccent,
              strokeWidth: 3,
              strokeDasharray: '5,5',
            },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: activeTheme.colors.brandAccent,
              width: 20,
              height: 20,
            },
          });
        });
      }
    });

    return { nodes, edges };
  }, [departments, teams, onView, handleViewTeam]);

  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  if (initialNodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-text-muted">
        <Building2 size={64} className="mb-4" />
        <p className="text-lg font-medium">{t('structureNotFound')}</p>
        <p className="text-sm mt-2">{t('checkDepartmentsData')}</p>
      </div>
    );
  }

  return (
    <div className="bg-surface-page rounded-[--radius-card] border-2 border-surface-border overflow-hidden shadow-xl" style={{ height: '800px' }}>
      <div className="p-6 border-b border-surface-border bg-surface-card/90 backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-2xl font-bold text-text-heading mb-1 flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-brand-primary to-brand-primary-dark rounded-[--radius-card] flex items-center justify-center shadow-lg shadow-brand-primary/30">
                <Building2 size={20} className="text-text-on-brand" />
              </div>
              {t('title')}
            </h3>
            <p className="text-sm text-text-muted ms-13">{t('subtitle')}</p>
          </div>
          
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 px-3 py-2 bg-brand-accent/10 rounded-[--radius-card] border border-brand-accent/30">
              <div className="w-3 h-3 rounded-full bg-brand-accent"></div>
              <span className="text-xs font-semibold text-text-body">{t('legendCeo')}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 bg-brand-primary/10 rounded-[--radius-card] border border-brand-primary/30">
              <div className="w-3 h-3 rounded-full bg-brand-primary"></div>
              <span className="text-xs font-semibold text-text-body">{t('legendDepartment')}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-2 bg-brand-accent/10 rounded-[--radius-card] border border-brand-accent/30">
              <div className="w-3 h-3 rounded-full bg-brand-accent"></div>
              <span className="text-xs font-semibold text-text-body">{t('legendTeam')}</span>
            </div>
          </div>
        </div>
      </div>
      
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3, minZoom: 0.4, maxZoom: 1.2 }}
        minZoom={0.2}
        maxZoom={1.5}
        defaultViewport={{ x: 0, y: 0, zoom: 0.6 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color={activeTheme.colors.textMuted} gap={24} size={1.5} style={{ opacity: 0.15 }} />
        <Controls showInteractive={false} className="bg-surface-card/90 backdrop-blur-sm border-2 border-surface-border rounded-[--radius-card] shadow-xl" />
        <MiniMap
          nodeColor={(node) => {
            if (node.type === 'team') return activeTheme.colors.brandAccent;
            if (node.data.level === 0) return activeTheme.colors.brandAccent;
            return activeTheme.colors.brandPrimary;
          }}
          className="bg-surface-card/90 backdrop-blur-sm border-2 border-surface-border rounded-[--radius-card] shadow-xl"
          maskColor="rgba(0, 0, 0, 0.08)"
        />
      </ReactFlow>
    </div>
  );
}
