import React from 'react';
import { Clock, ShieldCheck, BarChart3, Users, FileText, Calendar, Smartphone, TrendingUp, CheckCircle, Lock, Mail, Layout } from 'lucide-react';
import { motion } from 'framer-motion';

// --- Visual Components for Cards ---

const AttendanceVisual = () => (
  <div className="relative w-full h-full bg-text-heading rounded-[--radius-card] overflow-hidden flex items-center justify-center border border-surface-border">
    <div className="absolute inset-0 opacity-20 bg-[linear-gradient(rgba(255,255,255,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.1)_1px,transparent_1px)] bg-[size:20px_20px]"></div>
    
    <div className="w-24 h-24 bg-surface-card rounded-[--radius-card] p-2 relative z-10 flex items-center justify-center">
      <Clock size={48} className="text-brand-primary" />
    </div>

    <motion.div 
      animate={{ opacity: [0, 0, 1, 0] }}
      transition={{ duration: 2, repeat: Infinity, times: [0, 0.45, 0.5, 1] }}
      className="absolute inset-0 bg-status-success/20 z-30 flex items-center justify-center"
    >
        <div className="bg-status-success text-text-on-brand text-xs font-bold px-3 py-1 rounded-[--radius-badge] shadow-lg">Attendance was successful</div>
    </motion.div>
  </div>
);

const ChartVisual = () => (
  <div className="w-full h-full flex items-end justify-between gap-2 px-4 pb-4 pt-8 bg-surface-card rounded-[--radius-card] border border-surface-border relative overflow-hidden">
     <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-transparent to-brand-primary-light/10"></div>
     {[40, 70, 50, 90, 60].map((h, i) => (
        <motion.div
            key={i}
            initial={{ height: '10%' }}
            whileInView={{ height: `${h}%` }}
            transition={{ duration: 1, delay: i * 0.1, repeat: Infinity, repeatType: "reverse", repeatDelay: 2 }}
            className="w-full bg-brand-primary rounded-t-sm opacity-80"
        />
     ))}
  </div>
);

const SecurityVisual = () => (
  <div className="w-full h-full flex items-center justify-center bg-brand-primary rounded-[--radius-card] relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-brand-primary-light/20 to-transparent"></div>
      
      <motion.div 
        animate={{ rotate: 360 }}
        transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
        className="absolute w-40 h-40 border border-dashed border-white/20 rounded-full m-auto inset-0"
      ></motion.div>

      <motion.div
        animate={{ scale: [1, 1.05, 1] }}
        transition={{ duration: 2, repeat: Infinity }}
        className="relative z-10"
      >
        <ShieldCheck size={72} className="text-text-on-brand" />
      </motion.div>
  </div>
);

const ReportVisual = () => (
  <div className="w-full h-full bg-surface-page rounded-[--radius-card] p-4 relative border border-surface-border flex flex-col items-center justify-center">
      <motion.div 
        initial={{ y: 20, opacity: 0 }}
        whileInView={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="w-3/4 aspect-[1.4] bg-surface-card shadow-xl shadow-surface-page/50 border border-surface-border p-4 flex flex-col gap-3 rounded-[--radius-button]"
      >
          <div className="h-2 w-1/3 bg-surface-page rounded"></div>
          <div className="h-1 w-3/4 bg-surface-page rounded"></div>
          <div className="h-1 w-2/3 bg-surface-page rounded"></div>
          <div className="mt-auto flex justify-between items-end">
             <div className="w-10 h-10 rounded-full bg-brand-primary flex items-center justify-center shadow-lg shadow-brand-primary/30">
                 <FileText size={20} className="text-text-on-brand" />
             </div>
             <div className="h-8 w-16 bg-surface-page rounded"></div>
          </div>
      </motion.div>
      <div className="absolute top-3 right-3">
         <Mail size={18} className="text-text-muted" />
      </div>
  </div>
);

const WebAppVisual = () => (
  <div className="w-full h-full bg-surface-page rounded-[--radius-card] p-4 relative border border-surface-border overflow-hidden flex items-center justify-center">
      <div className="absolute inset-0 opacity-60 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-surface-border to-transparent"></div>
      
      <motion.div 
         initial={{ y: 20, opacity: 0 }}
         whileInView={{ y: 0, opacity: 1 }}
         transition={{ duration: 0.5 }}
         className="w-5/6 bg-surface-card rounded-[--radius-button] shadow-xl border border-surface-border overflow-hidden"
      >
          <div className="h-6 bg-surface-page border-b border-surface-border flex items-center px-2 gap-1.5">
              <div className="w-2 h-2 rounded-full bg-status-error"></div>
              <div className="w-2 h-2 rounded-full bg-status-warning"></div>
              <div className="w-2 h-2 rounded-full bg-status-success"></div>
              <div className="ml-2 w-full h-3 bg-surface-card rounded-sm"></div>
          </div>
          <div className="p-3 space-y-2">
              <div className="flex gap-2">
                   <div className="w-8 h-8 rounded bg-brand-primary/10"></div>
                   <div className="flex-1 space-y-1">
                       <div className="w-2/3 h-2 bg-surface-page rounded"></div>
                       <div className="w-1/2 h-2 bg-surface-page rounded"></div>
                   </div>
              </div>
              <div className="h-16 bg-surface-page rounded border border-surface-border border-dashed flex items-center justify-center">
                  <Users size={24} className="text-brand-primary/20" />
              </div>
          </div>
      </motion.div>

      <motion.div
         animate={{ y: [0, -10, 0] }}
         transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
         className="absolute -right-2 -bottom-2 w-20 h-32 bg-text-heading rounded-[--radius-card] border-4 border-text-heading/90 shadow-2xl p-1"
      >
          <div className="w-full h-full bg-surface-card rounded-[--radius-button] opacity-90"></div>
      </motion.div>
  </div>
);

// --- Main Feature Card Component ---

const BentoCard: React.FC<{
  title: string;
  desc: string;
  className?: string;
  visual?: React.ReactNode;
  icon?: React.ReactNode;
  delay?: number;
}> = ({ title, desc, className = "", visual, icon, delay = 0 }) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, delay }}
      className={`bg-surface-card rounded-[--radius-card] p-6 border border-surface-border shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 flex flex-col overflow-hidden relative group ${className}`}
    >
      <div className="flex-1 min-h-[180px] mb-6 relative rounded-[--radius-card] overflow-hidden group-hover:scale-[1.02] transition-transform duration-500">
         {visual ? visual : (
            <div className="w-full h-full bg-surface-page flex items-center justify-center">
                <div className="p-4 bg-surface-card rounded-[--radius-card] shadow-sm text-brand-primary">
                    {icon}
                </div>
            </div>
         )}
      </div>
      
      <div className="relative z-10">
        <h3 className="text-xl font-bold text-text-heading mb-2 flex items-center gap-2">
           {icon && <span className="text-brand-accent">{React.cloneElement(icon as React.ReactElement<any>, { size: 20 })}</span>}
           {title}
        </h3>
        <p className="text-text-body text-sm leading-relaxed">{desc}</p>
      </div>
    </motion.div>
  );
};

const Features: React.FC = () => {
  return (
    <section id="features" className="py-24 bg-surface-page relative overflow-hidden">
      <div className="container mx-auto px-6 relative z-10">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <motion.span 
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            className="text-brand-accent font-bold tracking-wider uppercase text-xs bg-brand-accent/10 px-3 py-1 rounded-[--radius-badge] border border-brand-accent/20"
          >
            Outstanding features
          </motion.span>
          <motion.h2 
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-4xl md:text-5xl font-bold text-text-heading mt-4 mb-6 tracking-tight"
          >
            Solution <span className="text-brand-primary">comprehensive</span>
          </motion.h2>
          <p className="text-text-muted text-lg">
             Optimize every human resource management process in your business.
          </p>
        </div>

        {/* Asymmetric Bento Grid */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
            
            {/* Row 1 */}
            <BentoCard 
               className="md:col-span-7 bg-gradient-to-br from-surface-card to-brand-accent/5"
               title="Smart timekeeping"
               desc="Automatic timekeeping system with many methods: fingerprint, face, GPS. Integrated warnings for arriving late, leaving early and automatic work calculation."
               visual={<AttendanceVisual />}
               icon={<CheckCircle />}
               delay={0.1}
            />
            
            <BentoCard 
               className="md:col-span-5"
               title="Dashboard Real-time"
               desc="Track HR metrics, chart trends and export reports with just 1 click."
               visual={<ChartVisual />}
               icon={<BarChart3 />}
               delay={0.2}
            />
 
            {/* Row 2 */}
            <BentoCard 
               className="md:col-span-4"
               title="Absolute security"
               desc="AES-256 standard data encryption. Multi-level authorization for Admin, Manager and Employees."
               visual={<SecurityVisual />}
               icon={<Lock />}
               delay={0.3}
            />

            <BentoCard 
               className="md:col-span-4"
               title="Automatic reporting"
               desc="The system automatically generates and sends periodic timekeeping, leave, and overtime reports via email."
               visual={<ReportVisual />}
               icon={<FileText />}
               delay={0.4}
            />
            
            <BentoCard 
               className="md:col-span-4"
               title="Employee Web Portal"
               desc="Smooth Mobile Web experience, no installation required. Employees manage work anytime, anywhere."
               visual={<WebAppVisual />}
               icon={<Layout />}
               delay={0.5}
            />
        </div>
      </div>
    </section>
  );
};

export default Features;
