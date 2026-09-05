import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Minus } from 'lucide-react';

const FAQItem: React.FC<{ question: string; answer: string }> = ({ question, answer }) => {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <div className="border-b border-surface-border last:border-0">
            <button 
                onClick={() => setIsOpen(!isOpen)}
                className="w-full py-6 flex items-center justify-between text-left hover:text-brand-primary transition-colors cursor-pointer"
            >
                <span className="text-lg font-bold text-text-heading pr-8">{question}</span>
                <span className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors ${isOpen ? 'bg-brand-primary text-text-on-brand' : 'bg-surface-page text-text-muted'}`}>
                    {isOpen ? <Minus size={16} /> : <Plus size={16} />}
                </span>
            </button>
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        <p className="pb-6 text-text-body leading-relaxed">
                            {answer}
                        </p>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

const FAQ: React.FC = () => {
    const faqs = [
        {
            question: "Does the system limit the number of employees?",
            answer: "No. Ess Portal is designed on a Cloud Computing platform with automatic scalability, supporting from 10 to 10,000+ employees."
        },
        {
            question: "How to integrate with existing company data?",
            answer: "We provide a standard RESTful API set and support importing employee lists via Excel/CSV. The technical team will support connection to your current system."
        },
        {
            question: "How are implementation costs calculated?",
            answer: "We have flexible packages by month/year or by employee size. Please contact the sales department to receive a detailed quote."
        },
        {
            question: "What to do if an employee forgets to clock in?",
            answer: "Managers can support manual timekeeping or employees can submit additional timekeeping applications through the system for management to approve."
        }
    ];

    return (
        <section className="py-24 bg-surface-card">
            <div className="container mx-auto px-6">
                <div className="flex flex-col lg:flex-row gap-16">
                    <div className="lg:w-1/3">
                        <span className="text-brand-accent font-bold uppercase tracking-wider text-sm">Support</span>
                        <h2 className="text-4xl font-bold mt-2 mb-6 text-text-heading">Frequently asked questions</h2>
                        <p className="text-text-body mb-8">
                            If you have other questions, please contact us directly through our support channels.
                        </p>
                        <a href="#contact" className="text-brand-primary font-bold hover:underline">Contact for consultation &rarr;</a>
                    </div>
                    <div className="lg:w-2/3">
                        {faqs.map((faq, index) => (
                            <FAQItem key={index} {...faq} />
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
};

export default FAQ;
