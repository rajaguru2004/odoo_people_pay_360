'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { ArrowUpRight, Camera, Sparkles, Heart } from 'lucide-react';
import Button from './Button';

interface GalleryItemProps {
  type: 'text' | 'image';
  title?: string;
  desc?: string;
  action?: string;
  src?: string;
  category?: string;
  className?: string;
  index: number;
}

const GalleryItem: React.FC<GalleryItemProps> = ({ type, title, desc, action, src, category, className, index }) => {
  if (type === 'text') {
    return (
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true }}
        transition={{ delay: index * 0.1 }}
        className={`relative p-8 md:p-12 flex flex-col justify-center items-start bg-brand-primary text-white overflow-hidden rounded-[2rem] shadow-xl ${className}`}
      >
        {/* Decorative Background Elements */}
        <div className="absolute top-0 right-0 p-12 opacity-10 transform translate-x-1/3 -translate-y-1/3">
          <Camera size={240} strokeWidth={1} />
        </div>
        <div className="absolute bottom-0 left-0 w-64 h-64 bg-brand-accent/20 blur-[100px] rounded-full"></div>
        
        <div className="relative z-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 border border-white/20 backdrop-blur-md mb-6">
            <Sparkles size={14} className="text-brand-accent" />
            <span className="text-xs font-bold text-brand-primary-light uppercase tracking-wider">Library 2026</span>
          </div>
          <h2 className="text-3xl md:text-5xl font-bold mb-6 leading-tight">
            {title}
          </h2>
          <p className="text-brand-primary-light/80 text-lg mb-8 max-w-md leading-relaxed">
            {desc}
          </p>
          <Button variant="white" className="group shadow-2xl shadow-brand-primary/50">
            {action}
            <ArrowUpRight className="ml-2 w-5 h-5 group-hover:rotate-45 transition-transform text-brand-primary" />
          </Button>
        </div>
      </motion.div>
    )
  }

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: index * 0.1 }}
      className={`group relative overflow-hidden rounded-[2rem] bg-gray-100 shadow-md hover:shadow-2xl transition-all duration-500 ${className}`}
    >
      {/* Overlay on Hover */}
      <div className="absolute inset-0 bg-gradient-to-t from-brand-primary/90 via-brand-primary/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity z-10 duration-500"></div>
      
      {/* Image */}
      <img 
        src={src} 
        alt={category} 
        className="w-full h-full object-cover transform group-hover:scale-105 transition-transform duration-700"
      />
      
      {/* Floating Category Badge */}
      <div className="absolute top-4 right-4 z-20">
        <span className="bg-white/90 backdrop-blur text-primary text-xs font-bold px-3 py-1.5 rounded-full shadow-lg flex items-center gap-1">
          <Sparkles size={10} className="text-brand-accent" />
          {category}
        </span>
      </div>

      {/* Bottom Content on Hover */}
      <div className="absolute bottom-0 left-0 right-0 p-6 z-20 translate-y-4 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300">
        <div className="flex justify-between items-center">
          <span className="text-white font-medium">View Details</span>
          <button className="p-2 bg-white rounded-full text-brand-primary hover:bg-brand-accent hover:text-white transition-colors">
            <ArrowUpRight size={18} />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

const Gallery: React.FC = () => {
  const items = [
    {
      type: 'text' as const,
      title: "Preserve every memorable moment",
      desc: "Images of company activities, team building, and special events are easily stored and shared.",
      action: "Explore the library",
      className: "md:col-span-2 md:row-span-2"
    },
    {
      type: 'image' as const,
      src: "https://images.unsplash.com/photo-1522071820081-009f0129c71c?q=80&w=800&auto=format&fit=crop", 
      category: "Team Building",
      className: "md:col-span-1 md:row-span-2"
    },
    {
      type: 'image' as const,
      src: "https://images.unsplash.com/photo-1556761175-b413da4baf72?q=80&w=800&auto=format&fit=crop", 
      category: "Office",
      className: "md:col-span-1 md:row-span-1"
    },
    {
      type: 'image' as const,
      src: "https://images.unsplash.com/photo-1511632765486-a01980e01a18?q=80&w=800&auto=format&fit=crop",
      category: "Networking",
      className: "md:col-span-1 md:row-span-1"
    },
    {
      type: 'image' as const,
      src: "https://images.unsplash.com/photo-1523240795612-9a054b0db644?q=80&w=800&auto=format&fit=crop",
      category: "Train",
      className: "md:col-span-2 md:row-span-1"
    },
    {
      type: 'image' as const,
      src: "https://images.unsplash.com/photo-1544531696-6057a701f568?q=80&w=800&auto=format&fit=crop",
      category: "Seminar",
      className: "md:col-span-1 md:row-span-1"
    },
    {
      type: 'image' as const,
      src: "https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?q=80&w=800&auto=format&fit=crop",
      category: "Workshop",
      className: "md:col-span-1 md:row-span-1"
    }
  ];

  return (
    <section className="py-24 bg-offWhite relative overflow-hidden">
      {/* Background Pattern */}
      <div className="absolute inset-0 opacity-20"></div>
      
      <div className="container mx-auto px-6 relative z-10">
        <div className="grid grid-cols-1 md:grid-cols-4 auto-rows-[250px] gap-6">
          {items.map((item, index) => (
            <GalleryItem key={index} index={index} {...item} />
          ))}
        </div>
        
        {/* Decorative floating elements */}
        <motion.div 
          animate={{ y: [0, -20, 0] }}
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          className="absolute -left-12 bottom-1/4 hidden lg:block"
        >
          <div className="bg-white p-3 rounded-2xl shadow-xl rotate-12 transform hover:rotate-0 transition-transform">
            <Heart className="text-status-error w-8 h-8 fill-current" />
          </div>
        </motion.div>
      </div>
    </section>
  );
};

export default Gallery;
