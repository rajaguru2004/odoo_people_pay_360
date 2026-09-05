import React from 'react';
import { motion } from 'framer-motion';
import { Trophy, Medal, Crown, Star, TrendingUp, Flame, Users, ArrowRight } from 'lucide-react';
import Button from './Button';

const TopStudentRow: React.FC<{ 
    rank: number; 
    name: string; 
    faculty: string; 
    points: number; 
    events: number; 
    avatar: string; 
}> = ({ rank, name, faculty, points, events, avatar }) => {
    
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
                <p className="text-xs text-text-muted truncate">{faculty}</p>
            </div>
            <div className="text-right">
                <div className="font-bold text-brand-primary text-lg">{points}</div>
                <div className="text-[10px] text-text-muted uppercase font-bold tracking-wider">Point</div>
            </div>
        </motion.div>
    );
};

const TrendingEventCard: React.FC<{
    rank: number;
    title: string;
    rating: number;
    participants: number;
    image: string;
    category: string;
}> = ({ rank, title, rating, participants, image, category }) => (
    <motion.div 
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ delay: rank * 0.1 }}
        className="group relative bg-surface-card rounded-[--radius-card] overflow-hidden border border-surface-border shadow-sm hover:shadow-xl transition-all duration-300 flex"
    >
        <div className="w-32 h-full relative flex-shrink-0">
             <img src={image} alt={title} className="w-full h-full object-cover absolute inset-0 transform group-hover:scale-110 transition-transform duration-700" />
             <div className="absolute top-2 left-2 bg-black/60 backdrop-blur text-text-on-brand text-xs font-bold px-2 py-0.5 rounded-[--radius-button]">
                #{rank}
             </div>
        </div>
        <div className="p-4 flex flex-col justify-between flex-1">
             <div>
                <span className="text-[10px] font-bold text-brand-accent uppercase tracking-wider mb-1 block">{category}</span>
                <h4 className="font-bold text-text-heading text-sm md:text-base line-clamp-2 group-hover:text-brand-primary transition-colors mb-2">
                    {title}
                </h4>
             </div>
             
             <div className="flex items-center justify-between mt-2">
                  <div className="flex items-center gap-1 bg-status-warning-bg px-2 py-1 rounded-[--radius-button] border border-status-warning/20">
                      <Star size={12} className="text-status-warning fill-status-warning" />
                      <span className="text-xs font-bold text-text-body">{rating}</span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-text-muted">
                      <Users size={12} />
                      <span>{participants}+</span>
                  </div>
             </div>
        </div>
        
        {rank === 1 && (
             <div className="absolute top-2 right-2">
                  <div className="relative">
                     <span className="absolute -inset-1 rounded-full bg-status-error blur opacity-40 animate-pulse"></span>
                     <Flame size={18} className="text-status-error relative z-10 fill-status-error" />
                  </div>
             </div>
        )}
    </motion.div>
);

const Leaderboard: React.FC = () => {
  const students = [
      { rank: 1, name: "Tran Minh Tam", faculty: "Khoa CNTT", points: 2450, events: 45, avatar: "https://i.pravatar.cc/100?img=33" },
      { rank: 2, name: "Nguyen Thao Ly", faculty: "Faculty of Economics", points: 2100, events: 38, avatar: "https://i.pravatar.cc/100?img=5" },
      { rank: 3, name: "Le Hoang Nam", faculty: "Faculty of Construction", points: 1950, events: 32, avatar: "https://i.pravatar.cc/100?img=11" },
      { rank: 4, name: "Pham Thi Hoa", faculty: "Department of Foreign Languages", points: 1800, events: 29, avatar: "https://i.pravatar.cc/100?img=24" },
      { rank: 5, name: "Vu Tuan Anh", faculty: "Department of Mechanical Engineering", points: 1750, events: 25, avatar: "https://i.pravatar.cc/100?img=59" },
  ];

  const trendingEvents = [
      { rank: 1, title: "Unplugged 2024 concert night", category: "Entertainment", rating: 4.9, participants: 5000, image: "https://images.unsplash.com/photo-1501281668745-f7f57925c3b4?auto=format&fit=crop&q=80&w=400" },
      { rank: 2, title: "Tech Talk: AI Revolution", category: "Academic", rating: 4.8, participants: 1200, image: "https://images.unsplash.com/photo-1544531696-6057a701f568?auto=format&fit=crop&q=80&w=400" },
      { rank: 3, title: "Blood donation day", category: "Volunteer", rating: 5.0, participants: 800, image: "https://images.unsplash.com/photo-1615461166324-cd1f91f9b9b0?auto=format&fit=crop&q=80&w=400" },
      { rank: 4, title: "Open student basketball tournament", category: "Sport", rating: 4.7, participants: 300, image: "https://images.unsplash.com/photo-1546519638-68e109498ffc?auto=format&fit=crop&q=80&w=400" },
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
                    Vinh danh <span className="text-brand-primary">Personal & Events</span>
                 </motion.h2>
                 <p className="text-text-muted max-w-2xl mx-auto">
                    Continuously updated in real time. Please actively participate to put your name on the school's golden board!
                 </p>
            </div>

            <div className="grid lg:grid-cols-2 gap-12 lg:gap-20">
                {/* Column 1: Top Students */}
                <div>
                    <div className="flex items-center justify-between mb-8">
                        <div className="flex items-center gap-3">
                            <div className="p-2.5 bg-brand-primary rounded-[--radius-card] text-text-on-brand shadow-lg shadow-brand-primary/30">
                                <Crown size={24} />
                            </div>
                            <div>
                                <h3 className="text-xl font-bold text-text-heading">Outstanding student</h3>
                                <p className="text-xs text-text-muted">Ranked by training points in November</p>
                            </div>
                        </div>
                        <Button variant="outline" size="sm" className="rounded-[--radius-badge] text-xs h-8 px-4">See all</Button>
                    </div>

                    <div className="space-y-4">
                        {students.map((student) => (
                            <TopStudentRow key={student.rank} {...student} />
                        ))}
                    </div>
                </div>

                {/* Column 2: Trending Events */}
                <div>
                    <div className="flex items-center justify-between mb-8">
                        <div className="flex items-center gap-3">
                            <div className="p-2.5 bg-brand-accent rounded-[--radius-card] text-text-on-accent shadow-lg shadow-brand-accent/30">
                                <TrendingUp size={24} />
                            </div>
                            <div>
                                <h3 className="text-xl font-bold text-text-heading">Trending events</h3>
                                <p className="text-xs text-text-muted">Most interested and appreciated</p>
                            </div>
                        </div>
                        <Button variant="outline" size="sm" className="rounded-[--radius-badge] text-xs h-8 px-4">Discover</Button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-4">
                        {trendingEvents.map((event) => (
                            <TrendingEventCard key={event.rank} {...event} />
                        ))}
                        
                        {/* Call to action card */}
                        <motion.div 
                            initial={{ opacity: 0 }}
                            whileInView={{ opacity: 1 }}
                            transition={{ delay: 0.5 }}
                            className="bg-brand-primary rounded-[--radius-card] p-6 text-text-on-brand text-center flex flex-col items-center justify-center border border-white/10 relative overflow-hidden group"
                        >
                            <div className="absolute inset-0 bg-gradient-to-br from-brand-accent/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                            <h4 className="font-bold text-lg mb-2 relative z-10">You want to organize an event?</h4>
                            <p className="text-brand-primary-light/80 text-sm mb-4 relative z-10">Register now to have your event featured here.</p>
                            <button className="text-sm font-bold bg-surface-card text-brand-primary px-4 py-2 rounded-[--radius-badge] hover:bg-brand-accent hover:text-text-on-accent transition-colors flex items-center gap-2 relative z-10">
                                Create an event now <ArrowRight size={14} />
                            </button>
                        </motion.div>
                    </div>
                </div>
            </div>
        </div>
    </section>
  );
};

export default Leaderboard;