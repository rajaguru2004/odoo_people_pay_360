'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import Button from './Button';
import { motion } from 'framer-motion';
import { Sparkles, PhoneCall } from 'lucide-react';

const CallToAction: React.FC = () => {
  const router = useRouter();

  return (
    <section className="py-24 relative overflow-hidden bg-surface-page">
      {/* Background Decor */}
      <div className="absolute top-0 right-0 w-[50%] h-full bg-gradient-to-l from-brand-primary-light/10 to-transparent"></div>

      <div className="container mx-auto px-6 relative z-20">
        <div className="bg-gradient-to-br from-brand-primary to-brand-primary-dark rounded-[3rem] p-8 md:p-16 text-center shadow-2xl overflow-hidden relative">

          {/* Abstract blobs inside the card */}
          <div className="absolute top-0 left-0 w-64 h-64 bg-brand-accent/30 rounded-full blur-[80px] -translate-x-1/2 -translate-y-1/2"></div>
          <div className="absolute bottom-0 right-0 w-80 h-80 bg-brand-primary-light/20 rounded-full blur-[100px] translate-x-1/2 translate-y-1/2"></div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            className="relative z-10 max-w-3xl mx-auto space-y-6"
          >
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 border border-white/20 backdrop-blur-md mb-2">
              <Sparkles size={16} className="text-brand-accent" />
              <span className="text-brand-primary-light text-sm font-medium">Enterprise digital transformation solutions</span>
            </div>

            <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
              Accompanying development <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-accent to-orange-300">
                Your business
              </span>
            </h2>

            <p className="text-lg text-brand-primary-light/80 max-w-2xl mx-auto leading-relaxed">
              We understand the difficulties in human resource management. Let Ess Portal become a powerful assistant for your business today.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-8">
              <Button
                variant="primary"
                size="lg"
                className="min-w-[200px] text-lg shadow-xl shadow-brand-accent/30 group"
                onClick={() => router.push('/login')}
              >
                <PhoneCall className="w-5 h-5 mr-2 group-hover:rotate-12 transition-transform" />
                Contact for cooperation
              </Button>
              <Button
                variant="glass"
                size="lg"
                className="min-w-[200px] text-lg border-white/20 hover:bg-white/10"
                onClick={() => router.push('/login')}
              >
                Get a demo
              </Button>
            </div>

            <p className="text-white/40 text-sm mt-8">
              Support for rapid deployment • Free user training • 100% data security
            </p>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default CallToAction;
