import React, { useEffect, useRef } from 'react';
import { motion, useInView, useMotionValue, useSpring } from 'framer-motion';

const Counter: React.FC<{ value: number; suffix?: string; label: string; decimals?: number }> = ({ value, suffix = "", label, decimals = 0 }) => {
    const ref = useRef<HTMLDivElement>(null);
    const motionValue = useMotionValue(0);
    const springValue = useSpring(motionValue, {
        damping: 30,
        stiffness: 100,
        duration: 2.5
    });
    const isInView = useInView(ref, { once: true, margin: "-100px" });

    useEffect(() => {
        if (isInView) {
            motionValue.set(value);
        }
    }, [isInView, value, motionValue]);

    useEffect(() => {
        return springValue.on("change", (latest) => {
            if (ref.current) {
                ref.current.textContent = latest.toFixed(decimals) + suffix;
            }
        });
    }, [springValue, decimals, suffix]);

    return (
        <div className="text-center px-4 py-6 rounded-2xl hover:bg-white/5 transition-colors duration-300 group">
            <div className="flex items-center justify-center mb-2">
                <span 
                    ref={ref} 
                    className="text-4xl md:text-5xl font-extrabold text-transparent bg-clip-text bg-gradient-to-b from-white to-white/70 tracking-tight group-hover:to-brand-accent transition-all"
                >
                    0
                </span>
            </div>
            <div className="h-1 w-8 bg-brand-accent/30 mx-auto rounded-full mb-3 group-hover:w-16 group-hover:bg-brand-accent transition-all duration-500"></div>
            <div className="text-sm font-bold text-brand-primary-light/60 uppercase tracking-widest group-hover:text-brand-primary-light transition-colors">
                {label}
            </div>
        </div>
    );
};

const Stats: React.FC = () => {
  return (
    <div className="bg-brand-primary py-20 border-y border-white/5 relative overflow-hidden">
      {/* Dynamic Background */}
      <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-brand-accent/10 rounded-full blur-[120px] -translate-y-1/2 translate-x-1/3 animate-pulse"></div>
      <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-brand-primary-light/5 rounded-full blur-[100px] translate-y-1/2 -translate-x-1/3"></div>
      
      {/* Grid Pattern */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:60px_60px]"></div>

      <div className="container mx-auto px-6 relative z-10">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-12 divide-x-0 md:divide-x divide-white/10">
            <Counter value={200} suffix="+" label="Enterprise" />
            <Counter value={50} suffix="K+" label="Management staff" />
            <Counter value={1} suffix="M+" label="Timekeeping / month" />
            <Counter value={99.9} suffix="%" label="Accuracy" decimals={1} />
        </div>
      </div>
    </div>
  );
};

export default Stats;