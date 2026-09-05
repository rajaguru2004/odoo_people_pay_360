import React from 'react';
import { motion } from 'framer-motion';
import { Quote } from 'lucide-react';

const Testimonials: React.FC = () => {
  const partners = [
    "Viettel Group", "FPT Software", "VinGroup", "Techcombank", "Masan Group", "Hoa Phat Group"
  ];

  const reviews = [
    {
      content: "Ess Portal has helped us save 80% of the time spent processing timekeeping and payroll. Employees are very satisfied with the user-friendly and easy-to-use interface.",
      author: "Nguyen Van An",
      role: "Human Resources Director - Viettel Group",
      avatar: "https://i.pravatar.cc/100?img=68"
    },
    {
      content: "Real-time reporting feature helps us grasp the personnel situation immediately. Stable system, good security and enthusiastic support.",
      author: "Le Thi Bich Ngoc",
      role: "Head of Administration Department - FPT Software",
      avatar: "https://i.pravatar.cc/100?img=49"
    }
  ];

  return (
    <section id="testimonials" className="py-24 bg-brand-primary text-white relative overflow-hidden">
        {/* Decorative background */}
        <div className="absolute top-0 left-0 w-full h-full opacity-5"></div>
        <div className="absolute -top-24 -right-24 w-96 h-96 bg-brand-accent/20 rounded-full blur-[100px]"></div>

      <div className="container mx-auto px-6 relative z-10">
        
        {/* Partners Section */}
        <div className="text-center mb-20">
          <p className="text-brand-primary-light/60 uppercase tracking-widest text-sm font-semibold mb-8">
            Trusted by leading businesses
          </p>
          <div className="flex flex-wrap justify-center gap-8 md:gap-16 opacity-70 grayscale hover:grayscale-0 transition-all duration-500">
             {partners.map((partner, i) => (
                 <span key={i} className="text-xl md:text-2xl font-bold text-white/40 hover:text-white transition-colors cursor-default">
                    {partner}
                 </span>
             ))}
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-8 max-w-5xl mx-auto">
          {reviews.map((review, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.2 }}
              className="bg-white/5 backdrop-blur-sm border border-white/10 p-8 rounded-3xl relative"
            >
              <Quote className="absolute top-8 right-8 text-brand-accent/30 w-12 h-12" />
              <p className="text-lg text-brand-primary-light/90 leading-relaxed mb-8 relative z-10">
                "{review.content}"
              </p>
              <div className="flex items-center gap-4">
                <img src={review.avatar} alt={review.author} className="w-12 h-12 rounded-full border-2 border-brand-accent" />
                <div>
                  <h4 className="font-bold text-white">{review.author}</h4>
                  <p className="text-sm text-brand-primary-light/60">{review.role}</p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Testimonials;
