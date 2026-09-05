import React from 'react';
import { motion } from 'framer-motion';
import { Shield, Lock, Server, FileKey, Check } from 'lucide-react';

const Security: React.FC = () => {
  return (
    <section className="py-24 bg-brand-primary text-white relative overflow-hidden">
        {/* Grid Background */}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.05)_1px,transparent_1px)] bg-[size:40px_40px]"></div>
        
        {/* Decorative Blobs */}
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-brand-accent/10 rounded-full blur-[100px] translate-x-1/3 -translate-y-1/3"></div>
        <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-brand-primary-light/5 rounded-full blur-[100px] -translate-x-1/3 translate-y-1/3"></div>

        <div className="container mx-auto px-6 relative z-10">
            <div className="flex flex-col lg:flex-row gap-16 items-center">
                <div className="lg:w-1/2">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 border border-white/20 text-brand-primary-light text-sm font-medium mb-6 backdrop-blur-md">
                        <Shield size={14} />
                        <span>Enterprise Grade Security</span>
                    </div>
                    <h2 className="text-4xl md:text-5xl font-bold mb-6 leading-tight">
                        Data security is <br/>
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-accent to-orange-300">
                            Top priority
                        </span>
                    </h2>
                    <p className="text-brand-primary-light/80 text-lg mb-8 leading-relaxed">
                        We adhere to the strictest security standards to ensure the absolute safety of business and employee data.
                    </p>

                    <div className="grid sm:grid-cols-2 gap-6">
                        {[
                            { icon: Lock, title: "AES-256 encryption", desc: "Data is end-to-end encrypted." },
                            { icon: Server, title: "Server in Vietnam", desc: "Comply with Cyber ​​Security laws." },
                            { icon: FileKey, title: "ISO 27001", desc: "Meets information security standards." },
                            { icon: Check, title: "Backup automatically", desc: "Backup data every hour." },
                        ].map((item, i) => (
                            <div key={i} className="flex gap-4 p-4 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition-colors">
                                <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                                    <item.icon className="text-brand-accent" size={20} />
                                </div>
                                <div>
                                    <h4 className="font-bold text-white">{item.title}</h4>
                                    <p className="text-sm text-brand-primary-light/60">{item.desc}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Animated Visual */}
                <div className="lg:w-1/2 relative flex justify-center">
                    <div className="relative w-80 h-80">
                        {/* Spinning Rings */}
                        <motion.div 
                            animate={{ rotate: 360 }}
                            transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                            className="absolute inset-0 rounded-full border border-white/10 border-t-brand-accent"
                        ></motion.div>
                        <motion.div 
                            animate={{ rotate: -360 }}
                            transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
                            className="absolute inset-4 rounded-full border border-white/10 border-b-brand-primary-light"
                        ></motion.div>
                        <motion.div 
                            animate={{ rotate: 180 }}
                            transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
                            className="absolute inset-8 rounded-full border border-white/5 border-l-white/20 border-dotted"
                        ></motion.div>

                        {/* Center Core */}
                        <div className="absolute inset-0 flex items-center justify-center">
                            <div className="w-32 h-32 rounded-full bg-cyan-500/20 blur-2xl"></div>
                            <div className="absolute w-32 h-32 rounded-full bg-brand-primary-dark border border-cyan-500/30 flex items-center justify-center shadow-2xl shadow-cyan-500/20">
                                <Shield size={48} className="text-cyan-400" />
                            </div>
                        </div>

                        {/* Floating Particles */}
                        <div className="absolute top-0 right-0 p-3 bg-white/10 backdrop-blur-md rounded-lg border border-white/10 text-xs text-white">
                            <span className="text-green-400">●</span> Encryption Active
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>
  );
};

export default Security;