'use client';

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bell, QrCode, Calendar, CheckCircle2, MapPin, Clock, Fingerprint, UserCheck } from 'lucide-react';

const FEATURES = [
  {
    id: 0,
    icon: <Fingerprint size={24} />,
    title: "Smart timekeeping",
    desc: "Timekeeping by fingerprint, face or QR code. Automatically record input/output times accurate to every second.",
  },
  {
    id: 1,
    icon: <Bell size={24} />,
    title: "Instant notifications",
    desc: "Receive push notifications about work schedules, approved leave, or shift changes instantly.",
  },
  {
    id: 2,
    icon: <Calendar size={24} />,
    title: "Work history",
    desc: "Automatically stores all attendance, leave, overtime and monthly payroll history.",
  }
];

// --- Phone Screen Components ---

const ScreenAttendance = () => (
  <div className="space-y-4">
    <div className="bg-surface-card p-4 rounded-[--radius-card] shadow-lg border border-surface-border relative overflow-hidden group">
      <div className="absolute top-0 right-0 w-16 h-16 bg-brand-primary/5 rounded-bl-full -mr-4 -mt-4"></div>
      
      <div className="flex justify-between items-start mb-4">
        <div>
          <div className="text-xs text-text-muted font-medium uppercase tracking-wider mb-1">Today</div>
          <div className="font-bold text-brand-primary text-lg">Monday, January 30, 2026</div>
          <div className="flex items-center gap-1 text-xs text-text-body mt-1">
            <MapPin size={10} /> Hanoi Office
          </div>
        </div>
      </div>
      
      <div className="flex items-center justify-between border-t border-dashed border-surface-border pt-4">
        <div className="space-y-1">
          <div className="text-xs text-text-muted">Now come in</div>
          <div className="font-semibold text-sm text-status-success">08:00 AM</div>
        </div>
        <div className="bg-surface-card p-1 rounded-[--radius-button] border border-surface-border shadow-inner">
          <Fingerprint size={48} className="text-brand-primary" />
        </div>
      </div>

      {/* Scan Animation */}
      <motion.div 
        className="absolute top-[60%] right-4 w-12 h-0.5 bg-status-success shadow-[0_0_10px_green]"
        animate={{ y: [-24, 24, -24] }}
        transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
      />
    </div>

    <div className="grid grid-cols-2 gap-3">
      <div className="h-20 bg-status-success-bg/50 border border-status-success/20 rounded-[--radius-card] p-3 flex flex-col justify-between">
        <UserCheck size={16} className="text-status-success" />
        <div className="text-xs font-medium text-status-success">Time has been scored</div>
      </div>
      <div className="h-20 bg-brand-accent/10 border border-brand-accent/20 rounded-[--radius-card] p-3 flex flex-col justify-between">
        <Clock size={16} className="text-brand-accent" />
        <div className="text-xs font-medium text-brand-accent">8h 30p</div>
      </div>
    </div>
  </div>
);

const ScreenNotifications = () => (
  <div className="space-y-3">
    <div className="flex justify-between items-center mb-2 px-1">
      <span className="font-bold text-sm text-text-heading">Latest</span>
      <span className="text-xs text-brand-primary font-medium">Mark as read</span>
    </div>
    {[
      { title: "Leave approved", msg: "The leave application dated February 5 has been approved.", time: "2m ago", active: true },
      { title: "Change work shifts", msg: "Next week's shift will change to the morning shift.", time: "1h ago", active: false },
      { title: "January salary slip", msg: "The salary schedule for January 2026 has been updated.", time: "3h ago", active: false },
    ].map((item, i) => (
      <div key={i} className={`bg-surface-card p-3 rounded-[--radius-card] border ${item.active ? 'border-l-4 border-l-brand-accent shadow-md' : 'border-surface-border shadow-sm'}`}>
        <div className="flex gap-3">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${item.active ? 'bg-brand-accent/10 text-brand-accent' : 'bg-surface-page text-text-muted'}`}>
            <Bell size={14} fill={item.active ? "currentColor" : "none"} />
          </div>
          <div className="flex-1">
            <div className="flex justify-between items-start">
              <h4 className={`text-sm font-bold ${item.active ? 'text-text-heading' : 'text-text-body'}`}>{item.title}</h4>
              <span className="text-[10px] text-text-muted">{item.time}</span>
            </div>
            <p className="text-xs text-text-body mt-1 leading-relaxed">{item.msg}</p>
          </div>
        </div>
      </div>
    ))}
  </div>
);

const ScreenHistory = () => (
  <div className="space-y-4">
    <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
      <div className="bg-brand-primary text-text-on-brand px-4 py-1.5 rounded-[--radius-badge] text-xs font-medium whitespace-nowrap shadow-lg shadow-brand-primary/30">All</div>
      <div className="bg-surface-card text-text-body border border-surface-border px-4 py-1.5 rounded-[--radius-badge] text-xs font-medium whitespace-nowrap">Timekeeping</div>
      <div className="bg-surface-card text-text-body border border-surface-border px-4 py-1.5 rounded-[--radius-badge] text-xs font-medium whitespace-nowrap">Vacation</div>
    </div>

    <div className="space-y-3">
      {[
        { title: "Timekeeping is on time", date: "January 30, 2026", status: "Complete", score: "+10d" },
        { title: "Paid leave", date: "January 25, 2026", status: "Approved", score: "" },
        { title: "Overtime", date: "January 20, 2026", status: "Approved", score: "+5d" },
      ].map((item, i) => (
        <div key={i} className="flex items-center justify-between bg-surface-card p-3 rounded-[--radius-card] border border-surface-border shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-[--radius-button] bg-surface-page flex flex-col items-center justify-center text-xs font-bold text-text-muted border border-surface-border">
              <span>{item.date.split('/')[0]}</span>
              <span className="text-[8px] font-normal">T{item.date.split('/')[1]}</span>
            </div>
            <div>
              <div className="text-sm font-bold text-text-heading">{item.title}</div>
              <div className="flex items-center gap-1 text-xs text-status-success mt-0.5">
                <CheckCircle2 size={10} /> {item.status}
              </div>
            </div>
          </div>
          {item.score && (
            <div className="text-xs font-bold text-brand-primary bg-brand-primary/5 px-2 py-1 rounded-[--radius-button]">
              {item.score}
            </div>
          )}
        </div>
      ))}
    </div>
  </div>
);

const AppShowcase: React.FC = () => {
  const [activeIndex, setActiveIndex] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
    }
  };

  const startTimer = () => {
    stopTimer();
    timerRef.current = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % FEATURES.length);
    }, 10000);
  };

  useEffect(() => {
    startTimer();
    return () => stopTimer();
  }, []);

  const handleFeatureClick = (index: number) => {
    setActiveIndex(index);
    startTimer();
  };

  return (
    <section className="py-24 bg-surface-page overflow-hidden">
      <div className="container mx-auto px-6">
        <div className="flex flex-col lg:flex-row items-center lg:items-start gap-16">
          
          {/* Sticky Phone Mockup */}
          <div className="lg:w-1/2 sticky top-24 h-[650px] flex items-center justify-center">
            <div className="relative w-[320px] h-[640px] bg-slate-900 rounded-[3rem] border-[8px] border-slate-900 shadow-2xl overflow-hidden z-10 transition-transform duration-500 hover:scale-[1.01]">
              {/* Screen Content */}
              <div className="absolute inset-0 bg-surface-page flex flex-col">
                
                {/* Static App Header */}
                <div className="bg-brand-primary h-36 p-6 pt-14 text-text-on-brand rounded-b-[2.5rem] relative z-10 shadow-lg flex-shrink-0">
                  <div className="flex justify-between items-center mb-4">
                    <div className="flex gap-3 items-center">
                      <div className="w-10 h-10 rounded-full bg-text-on-brand/20 border-2 border-text-on-brand/30 overflow-hidden">
                        <img src="https://i.pravatar.cc/100?img=12" alt="User" className="w-full h-full object-cover" />
                      </div>
                      <div>
                        <div className="text-xs opacity-70">Hello,</div>
                        <div className="font-bold text-sm">Nguyen Van A</div>
                      </div>
                    </div>
                    <div className="relative">
                      <Bell size={22} />
                      <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-status-error rounded-full border-2 border-brand-primary"></span>
                    </div>
                  </div>
                </div>

                {/* Dynamic Body Content */}
                <div className="flex-1 p-5 overflow-hidden relative -mt-6 z-20">
                  <AnimatePresence mode='wait'>
                    <motion.div
                      key={activeIndex}
                      initial={{ opacity: 0, y: 20, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -20, scale: 0.95 }}
                      transition={{ duration: 0.4 }}
                      className="h-full"
                    >
                      {activeIndex === 0 && <ScreenAttendance />}
                      {activeIndex === 1 && <ScreenNotifications />}
                      {activeIndex === 2 && <ScreenHistory />}
                    </motion.div>
                  </AnimatePresence>
                </div>
                
                {/* Bottom Nav */}
                <div className="h-20 bg-surface-card border-t border-surface-border flex justify-around items-center px-6 pb-2 text-text-muted flex-shrink-0">
                  {[0, 1, 2].map((idx) => (
                    <div key={idx} className={`flex flex-col items-center gap-1 transition-colors duration-300 ${activeIndex === idx ? 'text-brand-primary' : 'text-text-muted'}`}>
                      <div className={`w-6 h-6 rounded-full flex items-center justify-center`}>
                        {idx === 0 && <Fingerprint size={20} />}
                        {idx === 1 && <Bell size={20} />}
                        {idx === 2 && <Calendar size={20} />}
                      </div>
                      <div className={`w-1 h-1 rounded-full ${activeIndex === idx ? 'bg-brand-primary' : 'bg-transparent'}`}></div>
                    </div>
                  ))}
                </div>
              </div>
              
              {/* Phone Notch */}
              <div className="absolute top-0 left-1/2 transform -translate-x-1/2 w-32 h-7 bg-slate-900 rounded-b-xl z-30 flex items-center justify-center">
                <div className="w-12 h-1 bg-slate-800 rounded-full opacity-50"></div>
              </div>
            </div>

            {/* Background Decor Behind Phone */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[550px] h-[550px] bg-brand-primary/5 rounded-full blur-3xl -z-10 animate-pulse"></div>
          </div>

          {/* Feature List (Right Side) */}
          <div className="lg:w-1/2 pt-8 lg:pt-12 space-y-12">
            <div className="mb-10 text-center lg:text-left">
              <span className="text-brand-accent font-bold uppercase tracking-wider text-sm bg-brand-accent/10 px-3 py-1 rounded-[--radius-badge]">Ess Portal Mobile App</span>
              <h2 className="text-4xl font-bold mt-4 mb-4 text-text-heading">Human resources management <br/>right in your hand</h2>
              <p className="text-text-body text-lg leading-relaxed">
                The mobile application is optimally designed for employees, helping to manage work and not miss any important information.
              </p>
            </div>

            <div className="space-y-6 relative">
              {FEATURES.map((feature, index) => (
                <div 
                  key={feature.id}
                  onClick={() => handleFeatureClick(index)}
                  className={`
                    cursor-pointer group relative p-6 rounded-[--radius-card] transition-all duration-500 border-2
                    ${activeIndex === index 
                      ? 'bg-surface-card border-brand-primary/10 shadow-xl scale-100 lg:scale-105 z-10' 
                      : 'bg-transparent border-transparent hover:bg-surface-card/50 hover:border-surface-border opacity-60 hover:opacity-100'
                    }
                  `}
                >
                  {activeIndex === index && (
                    <motion.div 
                      layoutId="activeIndicator"
                      className="absolute left-0 top-0 bottom-0 w-1.5 bg-brand-accent rounded-l-[--radius-card]" 
                    />
                  )}

                  <div className="flex gap-5">
                    <div className={`
                      w-12 h-12 rounded-[--radius-button] flex items-center justify-center flex-shrink-0 transition-colors duration-300
                      ${activeIndex === index ? 'bg-brand-primary text-text-on-brand shadow-lg shadow-brand-primary/30' : 'bg-surface-page text-text-muted group-hover:bg-surface-card group-hover:text-brand-primary'}
                    `}>
                      {feature.icon}
                    </div>
                    <div>
                      <h3 className={`text-xl font-bold mb-2 transition-colors ${activeIndex === index ? 'text-text-heading' : 'text-text-body'}`}>
                        {feature.title}
                      </h3>
                      <p className="text-text-body leading-relaxed text-sm lg:text-base">
                        {feature.desc}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </section>
  );
};

export default AppShowcase;
