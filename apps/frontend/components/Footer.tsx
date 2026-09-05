'use client';

import React from 'react';
import { CalendarCheck, Facebook, Twitter, Instagram, Linkedin, Mail, Phone, MapPin } from 'lucide-react';
import { useBrandingStore } from '@/store/brandingStore';

function FooterLogo({ className = "w-6 h-6" }: { className?: string }) {
  const { branding } = useBrandingStore();

  if (branding.company_logo_svg?.trim()) {
    return (
      <div 
        className={`${className} flex items-center justify-center [&>svg]:w-full [&>svg]:h-full`}
        dangerouslySetInnerHTML={{ __html: branding.company_logo_svg }}
      />
    );
  }

  if (branding.company_logo_url?.trim()) {
    return (
      <img 
        src={branding.company_logo_url} 
        alt={branding.company_name} 
        className={`${className} object-contain rounded-md`} 
      />
    );
  }

  return null;
}

const Footer: React.FC = () => {
  const { branding } = useBrandingStore();
  const hasCustomLogo = !!(branding.company_logo_svg?.trim() || branding.company_logo_url?.trim());

  return (
    <footer id="footer" className="bg-brand-primary-dark text-text-on-brand pt-20 pb-10 border-t border-brand-primary-light/10">
      <div className="container mx-auto px-6">
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-12 mb-16">
          {/* Brand Column */}
          <div className="space-y-6">
            <div className="flex items-center gap-2.5">
              {hasCustomLogo ? (
                <div className="w-9 h-9 bg-surface-card border border-surface-border-light rounded-[--radius-badge] flex items-center justify-center p-1.5 shadow-sm overflow-hidden shrink-0 select-none animate-fade-in">
                  <FooterLogo className="w-6 h-6" />
                </div>
              ) : (
                <CalendarCheck className="text-brand-accent w-8 h-8 shrink-0" />
              )}
              <span className="text-2xl font-bold tracking-tight truncate max-w-[220px]" title={branding.company_name}>
                {hasCustomLogo ? (
                  branding.company_name
                ) : (
                  <>
                    <span className="text-brand-accent">Ess</span> Portal
                  </>
                )}
              </span>
            </div>
            <p className="text-brand-primary-light/80 leading-relaxed text-sm">
              The leading smart human resources management platform for medium and large enterprises in Vietnam.
            </p>
            <div className="flex gap-4">
              {[Facebook, Twitter, Instagram, Linkedin].map((Icon, i) => (
                <a key={i} href="#" className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center hover:bg-brand-accent transition-colors">
                  <Icon size={18} />
                </a>
              ))}
            </div>
          </div>

          {/* Quick Links */}
          <div>
            <h4 className="text-lg font-bold mb-6 text-text-on-brand">Product</h4>
            <ul className="space-y-4">
              {['Features', 'Price list', 'Download the application', 'API Document', 'Changelog'].map((item) => (
                <li key={item}>
                  <a href="#" className="text-brand-primary-light/70 hover:text-brand-accent transition-colors block">{item}</a>
                </li>
              ))}
            </ul>
          </div>

          {/* Support */}
          <div>
            <h4 className="text-lg font-bold mb-6 text-text-on-brand">Support</h4>
            <ul className="space-y-4">
              {['Help Center', 'Community', 'Terms of use', 'Privacy policy', 'Contact sales'].map((item) => (
                <li key={item}>
                  <a href="#" className="text-brand-primary-light/70 hover:text-brand-accent transition-colors block">{item}</a>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h4 className="text-lg font-bold mb-6 text-text-on-brand">Contact</h4>
            <ul className="space-y-4 text-brand-primary-light/70">
              <li className="flex items-start gap-3">
                <MapPin className="w-5 h-5 text-brand-accent flex-shrink-0 mt-1" />
                <span>12th Floor, Innovation Building, High-Tech Park, City. Ho Chi Minh</span>
              </li>
              <li className="flex items-center gap-3">
                <Phone className="w-5 h-5 text-brand-accent flex-shrink-0" />
                <span>1900 123 456</span>
              </li>
              <li className="flex items-center gap-3">
                <Mail className="w-5 h-5 text-brand-accent flex-shrink-0" />
                <span>contact@ess-portal.company.vn</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-brand-primary-light/10 pt-8 flex flex-col md:flex-row justify-between items-center gap-4 text-sm text-brand-primary-light/50">
          <p>© 2026 {branding.company_name}. All rights reserved.</p>
          <div className="flex gap-6">
            <a href="#" className="hover:text-text-on-brand transition-colors">Privacy Policy</a>
            <a href="#" className="hover:text-white transition-colors">Terms of Service</a>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;