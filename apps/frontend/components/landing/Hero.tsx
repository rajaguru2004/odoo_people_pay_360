'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Play, CheckCircle2, Star, Shield, Users, Mouse } from 'lucide-react';
import { motion } from 'framer-motion';
import Button from './Button';

const Hero: React.FC = () => {
  const router = useRouter();

  return (
    <section className="relative min-h-[100vh] flex items-center overflow-hidden bg-brand-primary pt-20">
      {/* Mesh Gradient Background */}
      <div className="absolute inset-0 w-full h-full opacity-60">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-brand-primary-light/20 rounded-full blur-[120px] animate-float" style={{ animationDuration: '8s' }}></div>
        <div className="absolute top-[20%] right-[-5%] w-[40%] h-[60%] bg-brand-accent/30 rounded-full blur-[100px] animate-float" style={{ animationDuration: '10s' }}></div>
        <div className="absolute bottom-[-10%] left-[20%] w-[40%] h-[40%] bg-brand-primary-dark/55 rounded-full blur-[120px] animate-float" style={{ animationDuration: '12s' }}></div>
      </div>

      {/* Grid Pattern Overlay */}
      <div className="absolute inset-0 opacity-10 brightness-100 contrast-150"></div>

      <div className="container mx-auto px-6 relative z-10 grid lg:grid-cols-2 gap-12 items-center pb-12">
        {/* Text Content */}
        <motion.div
          initial={{ opacity: 0, x: -50 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8 }}
          className="space-y-8"
        >
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="inline-flex items-center gap-2 bg-white/10 backdrop-blur-md px-4 py-2 rounded-full border border-white/20 hover:bg-white/20 transition-colors cursor-pointer group"
          >
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-accent opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-brand-accent"></span>
            </span>
            <span className="text-brand-primary-light text-sm font-medium tracking-wide">Version 3.0 has been released</span>
            <ArrowRight className="w-3 h-3 text-brand-primary-light group-hover:translate-x-1 transition-transform" />
          </motion.div>

          <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold text-white leading-[1.1] tracking-tight">
            Personnel management <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-accent via-status-error to-brand-primary-light animate-gradient bg-300%">
              Smart & Efficient
            </span>
          </h1>

          <p className="text-lg text-brand-primary-light/90 max-w-lg leading-relaxed font-light">
            Comprehensive solution helps businesses automate 100% of human resource management processes, timekeeping, leave and overtime.
          </p>

          <motion.div
            className="flex flex-wrap gap-4 pt-2"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
          >
            <Button
              variant="primary"
              size="lg"
              className="group shadow-brand-accent/25 shadow-lg"
              onClick={() => router.push('/login')}
            >
              Get started for free
              <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </Button>
            <Button
              variant="glass"
              size="lg"
              className="text-brand-primary-light border-brand-primary-light/30 hover:bg-brand-primary-light/10"
              onClick={() => router.push('/login')}
            >
              <Play className="mr-2 w-4 h-4 fill-current" />
              Watch the introductory video
            </Button>
          </motion.div>

          <div className="flex items-center gap-8 pt-8 border-t border-white/10">
            <div className="flex -space-x-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="w-10 h-10 rounded-full border-2 border-brand-primary bg-brand-primary overflow-hidden hover:-translate-y-1 transition-transform duration-300 z-0 hover:z-10">
                  <img src={`https://i.pravatar.cc/100?img=${i + 10}`} alt="User" className="w-full h-full object-cover" />
                </div>
              ))}
              <div className="w-10 h-10 rounded-full border-2 border-brand-primary bg-brand-accent text-white flex items-center justify-center text-xs font-bold z-10">
                2k+
              </div>
            </div>
            <div className="text-brand-primary-light/80 text-sm">
              <span className="text-white font-bold text-lg">200+</span> Businesses trust it
            </div>
          </div>
        </motion.div>

        {/* Visual Content */}
        <motion.div
          className="relative hidden lg:block perspective-1000"
          initial={{ opacity: 0, scale: 0.8, rotateY: -10 }}
          animate={{ opacity: 1, scale: 1, rotateY: 0 }}
          transition={{ duration: 1, ease: "easeOut" }}
          style={{ perspective: '1000px' }}
        >
          {/* Main Dashboard Card */}
          <motion.div
            className="relative z-20 bg-brand-primary/90 backdrop-blur-xl rounded-2xl border border-white/10 shadow-2xl overflow-hidden transform-style-3d rotate-y-6 hover:rotate-y-0 transition-transform duration-700"
            animate={{
              y: [0, -15, 0],
            }}
            transition={{
              duration: 6,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          >
            {/* Window Controls */}
            <div className="bg-white/5 border-b border-white/5 p-4 flex items-center justify-between">
              <div className="flex gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500/80"></div>
                <div className="w-3 h-3 rounded-full bg-yellow-500/80"></div>
                <div className="w-3 h-3 rounded-full bg-green-500/80"></div>
              </div>
              <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-black/20 border border-white/5">
                <Shield size={12} className="text-brand-primary-light" />
                <span className="text-[10px] text-brand-primary-light/80 font-mono">ess-portal.company.vn/secure</span>
              </div>
            </div>

            {/* Content */}
            <div className="p-6 grid grid-cols-3 gap-6">
              {/* Sidebar */}
              <div className="col-span-1 space-y-4">
                <div className="h-20 rounded-xl bg-gradient-to-br from-brand-primary-dark to-brand-primary border border-white/10 p-3">
                  <div className="h-2 w-12 bg-white/20 rounded mb-2"></div>
                  <div className="h-8 w-8 rounded-lg bg-white/10"></div>
                </div>
                <div className="space-y-2">
                  {[1, 2, 3].map(i => <div key={i} className="h-8 w-full rounded-lg bg-white/5"></div>)}
                </div>
              </div>

              {/* Main Area */}
              <div className="col-span-2 space-y-4">
                <div className="flex justify-between items-center">
                  <div>
                    <h3 className="text-white font-bold text-xl">Statistical</h3>
                    <p className="text-xs text-brand-primary-light/60">Updated 5 minutes ago</p>
                  </div>
                  <div className="bg-brand-accent/10 text-brand-accent text-xs px-2 py-1 rounded animate-pulse">Live</div>
                </div>

                {/* Chart Area */}
                <div className="h-32 flex items-end justify-between gap-2 p-4 rounded-xl bg-white/5 border border-white/5">
                  {[30, 50, 45, 80, 60, 95, 75].map((h, i) => (
                    <motion.div
                      key={i}
                      className="w-full bg-brand-primary-light/20 rounded-t-sm relative group overflow-hidden"
                      initial={{ height: 0 }}
                      animate={{ height: `${h}%` }}
                      transition={{ duration: 1, delay: 0.5 + i * 0.1 }}
                    >
                      <div className="absolute inset-0 bg-gradient-to-t from-brand-primary to-brand-primary-light opacity-80 group-hover:opacity-100 transition-opacity"></div>
                    </motion.div>
                  ))}
                </div>

                {/* Active Users Row */}
                <div className="flex gap-3">
                  <div className="flex-1 p-3 rounded-xl bg-brand-accent/10 border border-brand-accent/20 flex items-center gap-3">
                    <Users size={20} className="text-brand-accent" />
                    <div>
                      <div className="text-xs text-brand-primary-light/60">Online</div>
                      <div className="text-white font-bold">1,240</div>
                    </div>
                  </div>
                  <div className="flex-1 p-3 rounded-xl bg-white/5 border border-white/10 flex items-center gap-3">
                    <Star size={20} className="text-brand-primary-light" />
                    <div>
                      <div className="text-xs text-brand-primary-light/60">Evaluate</div>
                      <div className="text-white font-bold">4.9/5</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Floating Elements */}
          <motion.div
            className="absolute -right-8 top-20 z-30 glass-dark p-4 rounded-xl flex items-center gap-3 shadow-xl border-l-4 border-brand-accent bg-brand-primary-dark/85"
            animate={{ x: [0, 10, 0], y: [0, -10, 0] }}
            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          >
            <div className="bg-brand-accent/20 p-2 rounded-lg">
              <CheckCircle2 className="w-5 h-5 text-brand-accent" />
            </div>
            <div>
              <p className="text-xs text-brand-primary-light/60 font-medium">Status</p>
              <p className="text-sm font-bold text-white">Attendance was successful</p>
            </div>
          </motion.div>

          <motion.div
            className="absolute -left-10 bottom-20 z-30 glass-dark p-4 rounded-xl flex items-center gap-3 shadow-xl border-l-4 border-brand-primary-light bg-brand-primary-dark/85"
            animate={{ x: [0, -10, 0], y: [0, 10, 0] }}
            transition={{ duration: 5, repeat: Infinity, ease: "easeInOut", delay: 1 }}
          >
            <div className="bg-brand-primary-light/20 p-2 rounded-lg">
              <Users className="w-5 h-5 text-brand-primary-light" />
            </div>
            <div>
              <p className="text-xs text-brand-primary-light/60 font-medium">Employee</p>
              <p className="text-sm font-bold text-white">+45 new employees</p>
            </div>
          </motion.div>
        </motion.div>
      </div>

      {/* Scroll Down Indicator */}
      <motion.div
        className="absolute bottom-8 left-1/2 -translate-x-1/2 text-white/55 flex flex-col items-center gap-2 cursor-pointer hover:text-white transition-colors"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, y: [0, 10, 0] }}
        transition={{ duration: 2, repeat: Infinity, delay: 2 }}
        onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })}
      >
        <span className="text-xs uppercase tracking-widest font-medium">Discover</span>
        <Mouse size={24} />
      </motion.div>
    </section>
  );
};

export default Hero;