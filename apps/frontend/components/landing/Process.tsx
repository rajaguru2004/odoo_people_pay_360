import React from 'react';
import { motion } from 'framer-motion';
import { UserPlus, Clock, FileText, TrendingUp } from 'lucide-react';

const Process: React.FC = () => {
  const steps = [
    {
      id: 1,
      title: "More staff",
      desc: "Enter employee information, departments, positions and set up access rights in just 2 minutes.",
      icon: <UserPlus size={28} />,
      color: "bg-brand-primary",
      shadow: "shadow-brand-primary/30"
    },
    {
      id: 2,
      title: "Automatic timekeeping",
      desc: "Employees clock in via fingerprint, face or GPS. The system automatically calculates working hours.",
      icon: <Clock size={28} />,
      color: "bg-status-info",
      shadow: "shadow-status-info/30"
    },
    {
      id: 3,
      title: "Leave management & OT",
      desc: "Employees submit leave and overtime applications online. Real-time approval/rejection management.",
      icon: <FileText size={28} />,
      color: "bg-brand-accent",
      shadow: "shadow-brand-accent/30"
    },
    {
      id: 4,
      title: "Reporting & Analysis",
      desc: "Export detailed reports by day/month. Analyze trends and optimize performance.",
      icon: <TrendingUp size={28} />,
      color: "bg-status-success",
      shadow: "shadow-status-success/30"
    }
  ];

  return (
    <section className="py-24 bg-surface-page relative overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="text-center mb-20">
          <motion.div
             initial={{ opacity: 0, y: 10 }}
             whileInView={{ opacity: 1, y: 0 }}
             viewport={{ once: true }}
             className="inline-block mb-3 px-3 py-1 rounded-[--radius-badge] bg-surface-card border border-surface-border text-xs font-bold text-text-muted uppercase tracking-wider"
          >
             Operating procedures
          </motion.div>
          <motion.h2 
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-3xl md:text-5xl font-bold text-text-heading mb-6"
          >
            Simplify in <span className="text-brand-primary">4 steps</span>
          </motion.h2>
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1 }}
            className="text-text-muted text-lg max-w-2xl mx-auto"
          >
            We have optimized every step so you can focus on growing your business.
          </motion.p>
        </div>

        <div className="relative">
          {/* Animated Connecting Line (Desktop) */}
          <div className="hidden md:block absolute top-[45px] left-0 w-full h-1 z-0">
             <svg className="w-full h-20 absolute -top-10 left-0 overflow-visible">
                <motion.path
                    d="M 0 50 L 10000 50"
                    fill="transparent"
                    strokeWidth="3"
                    stroke="var(--color-surface-border)"
                    strokeDasharray="10 10"
                />
                 <motion.path
                    d="M 0 50 L 10000 50"
                    fill="transparent"
                    strokeWidth="3"
                    stroke="var(--color-brand-accent)"
                    initial={{ pathLength: 0 }}
                    whileInView={{ pathLength: 1 }}
                    transition={{ duration: 2, ease: "easeInOut" }}
                    viewport={{ once: true }}
                />
             </svg>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 relative z-10">
            {steps.map((step, index) => (
              <motion.div
                key={step.id}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.2, duration: 0.5 }}
                className="relative group"
              >
                <div className="bg-surface-card p-6 rounded-[--radius-card] border border-surface-border shadow-sm hover:shadow-2xl transition-all duration-300 relative z-10 h-full flex flex-col items-center text-center md:items-start md:text-left hover:-translate-y-2">
                  
                  {/* Step Number Badge */}
                  <div className={`
                    w-14 h-14 rounded-[--radius-input] ${step.color} text-text-on-brand flex items-center justify-center mb-6 
                    shadow-lg ${step.shadow} transform group-hover:scale-110 group-hover:rotate-6 transition-all duration-300
                    relative
                  `}>
                    {step.icon}
                    <div className="absolute -top-2 -right-2 w-6 h-6 bg-surface-card rounded-full flex items-center justify-center text-xs font-bold text-text-heading border border-surface-border shadow-sm">
                        {step.id}
                    </div>
                  </div>
                  
                  <h3 className="text-xl font-bold text-text-heading mb-3 group-hover:text-brand-primary transition-colors">{step.title}</h3>
                  <p className="text-text-body text-sm leading-relaxed">
                    {step.desc}
                  </p>
                </div>
                
                {/* Mobile Connector */}
                {index !== steps.length - 1 && (
                    <div className="md:hidden absolute left-1/2 bottom-[-32px] w-0.5 h-8 bg-surface-border -translate-x-1/2"></div>
                )}
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default Process;
