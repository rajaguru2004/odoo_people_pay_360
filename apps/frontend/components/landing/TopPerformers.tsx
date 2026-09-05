'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { Trophy, Medal, Crown, Star, TrendingUp, Flame, Users, ArrowRight, Award, Target } from 'lucide-react';
import Button from './Button';

const TopEmployeeRow: React.FC<{ 
  rank: number; 
  name: string; 
  department: string; 
  score: number; 
  projects: number; 
  avatar: string; 
}> = ({ rank, name, department, score, projects, avatar }) => {
  
  let rankIcon;
  let rankColor;
  let rankBg;

  switch (rank) {
    case 1:
      rankIcon = <Crown size={20} className="text-status-warning fill-status-warning" />;
      rankColor = "border-status-warning/40";
      rankBg = "bg-status-warning-bg/50";
      break;
    case 2:
      rankIcon = <Medal size={20} className="text-text-muted fill-text-muted/40" />;
      rankColor = "border-surface-border";
      rankBg = "bg-surface-page/50";
      break;
    case 3:
      rankIcon = <Medal size={20} className="text-brand-accent fill-brand-accent/60" />;
      rankColor = "border-brand-accent/40";
      rankBg = "bg-brand-accent/10";
      break;
    default:
      rankIcon = <span className="text-sm font-bold text-text-muted">#{rank}</span>;
      rankColor = "border-transparent";
      rankBg = "bg-surface-card";
  }

  return (
    <motion.div 
      initial={{ opacity: 0, x: -20 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true }}
      transition={{ delay: rank * 0.1 }}
      className={`flex items-center gap-4 p-4 rounded-[--radius-card] border ${rank <= 3 ? rankColor : 'border-surface-border'} ${rankBg} hover:shadow-lg transition-all duration-300 hover:scale-[1.02]`}
    >
      <div className="flex-shrink-0 w-8 flex justify-center">
        {rankIcon}
      </div>
      <div className="relative">
        <div className={`w-12 h-12 rounded-full border-2 p-0.5 ${rank <= 3 ? rankColor : 'border-surface-border'}`}>
          <img src={avatar} alt={name} className="w-full h-full rounded-full object-cover" />
        </div>
        {rank === 1 && (
          <motion.div 
            animate={{ rotate: [0, 10, -10, 0] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="absolute -top-3 -right-1 text-2xl"
          >
            👑
          </motion.div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="font-bold text-text-heading truncate">{name}</h4>
        <p className="text-xs text-text-muted truncate">{department}</p>
      </div>
      <div className="text-right">
        <div className="font-bold text-brand-primary text-lg">{score}</div>
        <div className="text-[10px] text-text-muted uppercase font-bold tracking-wider">Point</div>
      </div>
    </motion.div>
  );
};

const TopDepartmentCard: React.FC<{
  rank: number;
  name: string;
  rating: number;
  employees: number;
  performance: number;
  manager: string;
}> = ({ rank, name, rating, employees, performance, manager }) => (
  <motion.div 
    initial={{ opacity: 0, y: 20 }}
    whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true }}
    transition={{ delay: rank * 0.1 }}
    className="group relative bg-surface-card rounded-[--radius-card] overflow-hidden border border-surface-border shadow-sm hover:shadow-xl transition-all duration-300"
  >
    <div className="p-5">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-[--radius-card] bg-gradient-to-br from-brand-primary to-brand-primary-dark flex items-center justify-center text-text-on-brand font-bold text-lg shadow-lg">
            #{rank}
          </div>
          <div className="flex-1">
            <span className="text-[10px] font-bold text-brand-accent uppercase tracking-wider mb-1 block">Departments</span>
            <h4 className="font-bold text-text-heading text-sm md:text-base group-hover:text-brand-primary transition-colors">
              {name}
            </h4>
            <p className="text-xs text-text-muted mt-1">Manage: {manager}</p>
          </div>
        </div>
        {rank === 1 && (
          <div className="absolute top-4 right-4">
            <div className="relative">
              <span className="absolute -inset-1 rounded-full bg-status-error blur opacity-40 animate-pulse"></span>
              <Flame size={18} className="text-status-error relative z-10 fill-status-error" />
            </div>
          </div>
        )}
      </div>
      
      <div className="grid grid-cols-3 gap-3 mt-4">
        <div className="bg-status-warning-bg p-2 rounded-[--radius-button] border border-status-warning/20 text-center">
          <div className="flex items-center justify-center gap-1 mb-1">
            <Star size={12} className="text-status-warning fill-status-warning" />
            <span className="text-xs font-bold text-text-body">{rating}</span>
          </div>
          <div className="text-[10px] text-text-muted">Evaluate</div>
        </div>
        <div className="bg-brand-primary-light/10 p-2 rounded-[--radius-button] border border-brand-primary-light/20 text-center">
          <div className="flex items-center justify-center gap-1 mb-1">
            <Users size={12} className="text-brand-primary" />
            <span className="text-xs font-bold text-text-body">{employees}</span>
          </div>
          <div className="text-[10px] text-text-muted">Employee</div>
        </div>
        <div className="bg-status-success-bg p-2 rounded-[--radius-button] border border-status-success/20 text-center">
          <div className="flex items-center justify-center gap-1 mb-1">
            <Target size={12} className="text-status-success" />
            <span className="text-xs font-bold text-text-body">{performance}%</span>
          </div>
          <div className="text-[10px] text-text-muted">Efficiency</div>
        </div>
      </div>
    </div>
  </motion.div>
);

const TopPerformers: React.FC = () => {
  const topEmployees = [
    { rank: 1, name: "Nguyen Van An", department: "IT Department", score: 2450, projects: 45, avatar: "https://i.pravatar.cc/100?img=33" },
    { rank: 2, name: "Tran Thi Binh", department: "Accounting Department", score: 2100, projects: 38, avatar: "https://i.pravatar.cc/100?img=5" },
    { rank: 3, name: "Le Hoang Nam", department: "Human Resources Department", score: 1950, projects: 32, avatar: "https://i.pravatar.cc/100?img=11" },
    { rank: 4, name: "Pham Thi Hoa", department: "Marketing Department", score: 1800, projects: 29, avatar: "https://i.pravatar.cc/100?img=24" },
  ];

  const topDepartments = [
    { rank: 1, name: "Information Technology Department", manager: "Nguyen Van An", rating: 4.9, employees: 25, performance: 95 },
    { rank: 2, name: "Accounting Department", manager: "Tran Thi Binh", rating: 4.8, employees: 12, performance: 92 },
    { rank: 3, name: "Sales Department", manager: "Do Minh Tam", rating: 4.7, employees: 30, performance: 93 },
    { rank: 4, name: "Marketing Department", manager: "Pham Thi Hoa", rating: 4.6, employees: 15, performance: 90 },
  ];

  return (
    <section className="py-24 bg-surface-page relative overflow-hidden">
      {/* Background Elements */}
      <div className="absolute top-0 left-0 w-full h-full opacity-40"></div>
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-brand-primary/5 rounded-full blur-[100px]"></div>
      <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-brand-accent/5 rounded-full blur-[100px]"></div>

      <div className="container mx-auto px-6 relative z-10">
        <div className="text-center mb-16">
          <motion.div 
            initial={{ opacity: 0, scale: 0.8 }}
            whileInView={{ opacity: 1, scale: 1 }}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-[--radius-badge] bg-status-warning-bg border border-status-warning/20 text-status-warning text-xs font-bold uppercase tracking-wider mb-4"
          >
            <Trophy size={14} className="fill-status-warning" />
            Golden achievement board
          </motion.div>
          <motion.h2 
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            className="text-4xl font-bold text-text-heading mb-4"
          >
            Vinh danh <span className="text-brand-primary">Staff & Departments</span>
          </motion.h2>
          <p className="text-text-muted max-w-2xl mx-auto">
            Continuously updated in real time. Recognize outstanding contributions to the company's development!
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-12 lg:gap-20">
          {/* Column 1: Top Employees */}
          <div>
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-brand-primary rounded-[--radius-card] text-text-on-brand shadow-lg shadow-brand-primary/30">
                  <Crown size={24} />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-text-heading">Excellent staff</h3>
                  <p className="text-xs text-text-muted">Ranked by performance this month</p>
                </div>
              </div>
              <Button variant="outline" size="sm" className="rounded-[--radius-badge] text-xs h-8 px-4">See all</Button>
            </div>

            <div className="space-y-4">
              {topEmployees.map((employee) => (
                <TopEmployeeRow key={employee.rank} {...employee} />
              ))}
              
              {/* Call to action card */}
              <motion.div 
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                transition={{ delay: 0.5 }}
                className="bg-brand-primary rounded-[--radius-card] p-6 text-text-on-brand text-center flex flex-col items-center justify-center border border-white/10 relative overflow-hidden group mt-4"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-brand-accent/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                <Award size={48} className="mb-3 text-brand-primary-light relative z-10" />
                <h4 className="font-bold text-lg mb-2 relative z-10">You want to be honored?</h4>
                <p className="text-brand-primary-light/80 text-sm mb-4 relative z-10">Try your best and achieve excellent results.</p>
                <button className="text-sm font-bold bg-surface-card text-brand-primary px-4 py-2 rounded-[--radius-badge] hover:bg-brand-accent hover:text-text-on-accent transition-colors flex items-center gap-2 relative z-10">
                  See criteria <ArrowRight size={14} />
                </button>
              </motion.div>
            </div>
          </div>

          {/* Column 2: Top Departments */}
          <div>
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-brand-accent rounded-[--radius-card] text-text-on-accent shadow-lg shadow-brand-accent/30">
                  <TrendingUp size={24} />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-text-heading">Typical departments</h3>
                  <p className="text-xs text-text-muted">Top performance and ratings</p>
                </div>
              </div>
              <Button variant="outline" size="sm" className="rounded-[--radius-badge] text-xs h-8 px-4">Discover</Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-4">
              {topDepartments.map((dept) => (
                <TopDepartmentCard key={dept.rank} {...dept} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default TopPerformers;
