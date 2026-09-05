'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Menu, X, CalendarCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import Button from './landing/Button';
import { useBrandingStore } from '@/store/brandingStore';

function NavbarLogo({ className = "w-7 h-7" }: { className?: string }) {
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
        className={`${className} object-contain rounded-lg`} 
      />
    );
  }

  return null;
}

const Navbar: React.FC = () => {
  const router = useRouter();
  const { branding } = useBrandingStore();
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const hasCustomLogo = !!(branding.company_logo_svg?.trim() || branding.company_logo_url?.trim());

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const navLinks = [
    { name: 'Features', href: '#features' },
    { name: 'Employee', href: '#employees' },
    { name: 'Evaluate', href: '#testimonials' },
    { name: 'Contact', href: '#footer' },
  ];

  const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault();
    const element = document.querySelector(href);
    if (element) {
      const offset = 80; // Navbar height offset
      const elementPosition = element.getBoundingClientRect().top;
      const offsetPosition = elementPosition + window.pageYOffset - offset;

      window.scrollTo({
        top: offsetPosition,
        behavior: 'smooth'
      });
      setIsMobileMenuOpen(false);
    }
  };

  return (
    <>
      <motion.nav
        initial={{ y: -100 }}
        animate={{ y: 0 }}
        transition={{ duration: 0.5 }}
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 flex justify-center ${isScrolled ? 'py-4' : 'py-6'
          }`}
      >
        <div
          className={`
            flex items-center justify-between px-6 transition-all duration-300
            ${isScrolled
              ? 'w-[90%] max-w-6xl bg-surface-card/85 backdrop-blur-lg border border-surface-border shadow-lg rounded-[--radius-card] py-3'
              : 'w-full container bg-transparent py-2'
            }
          `}
        >
          {/* Logo */}
          <div 
            onClick={() => router.push('/')}
            className="flex items-center gap-2.5 cursor-pointer group"
          >
            {hasCustomLogo ? (
              <div className="w-10 h-10 bg-surface-card border border-surface-border-light rounded-[--radius-badge] flex items-center justify-center p-1.5 shadow-sm group-hover:scale-105 transition-transform shrink-0 overflow-hidden">
                <NavbarLogo className="w-7 h-7" />
              </div>
            ) : (
              <div className="w-10 h-10 bg-gradient-to-br from-brand-accent to-brand-accent-dark rounded-[--radius-badge] flex items-center justify-center shadow-lg shadow-brand-accent/20 group-hover:scale-105 transition-transform shrink-0">
                <CalendarCheck className="text-text-on-brand w-6 h-6" />
              </div>
            )}
            <span className={`text-xl font-bold tracking-tight ${isScrolled ? 'text-text-heading' : 'text-text-on-brand'} transition-colors truncate max-w-[220px]`} title={branding.company_name}>
              {hasCustomLogo ? (
                branding.company_name
              ) : (
                <>
                  <span className="text-brand-accent">Ess</span> Portal
                </>
              )}
            </span>
          </div>

          {/* Desktop Menu */}
          <div className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <a
                key={link.name}
                href={link.href}
                onClick={(e) => handleNavClick(e, link.href)}
                className={`text-sm font-medium hover:text-brand-accent transition-colors relative group cursor-pointer ${isScrolled ? 'text-text-body/75' : 'text-brand-primary-light/80'
                  }`}
              >
                {link.name}
                <span className="absolute -bottom-1 left-0 w-0 h-0.5 bg-brand-accent transition-all group-hover:w-full"></span>
              </a>
            ))}
          </div>

          {/* Desktop CTA */}
          <div className="hidden md:flex items-center gap-4">
            <Button
              variant={isScrolled ? "primary" : "white"}
              size="sm"
              onClick={() => router.push('/login')}
            >
              Access now
            </Button>
          </div>

          {/* Mobile Toggle */}
          <div className="md:hidden">
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className={`p-2 rounded-[--radius-button] ${isScrolled ? 'text-text-heading' : 'text-text-on-brand'}`}
            >
              {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
            </button>
          </div>
        </div>
      </motion.nav>

      {/* Mobile Menu Overlay */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="fixed inset-x-0 top-[70px] z-40 bg-surface-card border-b border-surface-border shadow-xl overflow-hidden md:hidden"
          >
            <div className="p-6 flex flex-col gap-4">
              {navLinks.map((link) => (
                <a
                  key={link.name}
                  href={link.href}
                  onClick={(e) => handleNavClick(e, link.href)}
                  className="text-text-heading font-medium text-lg py-2 border-b border-surface-border-light hover:text-brand-accent cursor-pointer"
                >
                  {link.name}
                </a>
              ))}
              <div className="mt-4">
                <Button
                  variant="primary"
                  fullWidth
                  onClick={() => router.push('/login')}
                >
                  Access now
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default Navbar;