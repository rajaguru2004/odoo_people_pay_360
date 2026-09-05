'use client';

import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Award, TrendingUp, Star } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface Performer {
  id: string;
  name: string;
  department: string;
  score: number;
  avatar?: string;
  achievements: number;
}

export default function TopPerformers() {
  const router = useRouter();
  const [performers, setPerformers] = useState<Performer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTopPerformers();
  }, []);

  const fetchTopPerformers = async () => {
    try {
      const axiosInstance = (await import('@/lib/axios')).default;
      
      // Fetch top performers from API
      const response = await axiosInstance.get('/employees/top-performers', {
        params: { limit: 5, period: 'month' }
      });

      if (response.data?.data) {
        setPerformers(response.data.data);
      }
    } catch (error) {
      console.error('Failed to fetch top performers:', error);
      setPerformers([]);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-surface-card rounded-2xl p-6 border border-surface-border">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-surface-page rounded w-1/3"></div>
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-16 bg-surface-page rounded-xl"></div>
          ))}
        </div>
      </div>
    );
  }

  const getRankColor = (index: number) => {
    if (index === 0) return 'bg-amber-500 border-2 border-amber-300';
    if (index === 1) return 'bg-slate-400 border-2 border-slate-300';
    if (index === 2) return 'bg-amber-700 border-2 border-amber-600';
    return 'bg-surface-page border-2 border-surface-border';
  };

  const getRankIcon = (index: number) => {
    if (index < 3) return '🏆';
    return '⭐';
  };

  return (
    <div className="bg-surface-card rounded-2xl p-6 border border-surface-border h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-bold text-text-heading">Excellent staff</h3>
          <p className="text-sm text-text-muted mt-1">Top 5 this month</p>
        </div>
        <Award className="text-brand-accent" size={24} />
      </div>

      {/* Performers List */}
      <div className="space-y-3">
        {performers.map((performer, index) => (
          <motion.div
            key={performer.id}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.1 }}
            onClick={() => router.push(`/dashboard/employees/${performer.id}`)}
            className="flex items-center gap-3 p-3 rounded-xl hover:bg-surface-page transition-colors cursor-pointer group"
          >
            {/* Rank Badge */}
            <div className={`w-10 h-10 rounded-full ${getRankColor(index)} flex items-center justify-center flex-shrink-0 text-white font-bold shadow-lg`}>
              <span className="text-lg">{getRankIcon(index)}</span>
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-bold text-text-heading truncate">{performer.name}</h4>
                {index < 3 && <Star className="text-brand-accent" size={14} fill="currentColor" />}
              </div>
              <p className="text-xs text-text-muted">{performer.department}</p>
            </div>

            {/* Score */}
            <div className="text-right">
              <div className="flex items-center gap-1 text-status-success">
                <TrendingUp size={14} />
                <span className="text-lg font-bold">{performer.score}</span>
              </div>
              <p className="text-xs text-text-muted">{performer.achievements} achievements</p>
            </div>
          </motion.div>
        ))}
      </div>

      {/* View All Button */}
      <button
        onClick={() => router.push('/dashboard/employees')}
        className="w-full mt-4 py-2 text-sm text-brand-primary hover:bg-surface-page rounded-lg transition-colors font-medium"
      >
        See all →
      </button>
    </div>
  );
}
