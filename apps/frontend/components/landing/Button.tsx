import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'white' | 'glass';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  children: React.ReactNode;
}

const Button: React.FC<ButtonProps> = ({ 
  variant = 'primary', 
  size = 'md', 
  fullWidth = false, 
  className = '', 
  children, 
  ...props 
}) => {
  const baseStyles = "inline-flex items-center justify-center font-bold transition-all duration-300 rounded-[--radius-button] focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95";
  
  const variants = {
    primary: "bg-brand-accent text-text-on-accent hover:bg-brand-accent-dark focus:ring-brand-accent shadow-lg shadow-brand-accent/30 hover:shadow-brand-accent/50",
    secondary: "bg-brand-primary text-text-on-brand hover:bg-brand-primary-dark focus:ring-brand-primary shadow-lg shadow-brand-primary/30",
    outline: "border-2 border-brand-primary/20 text-brand-primary hover:border-brand-primary hover:text-brand-primary bg-transparent",
    white: "bg-surface-card text-text-heading hover:bg-surface-page focus:ring-surface-card shadow-lg",
    glass: "bg-white/10 backdrop-blur-md border border-white/20 text-text-on-brand hover:bg-white/20 shadow-lg",
  };

  const sizes = {
    sm: "px-4 py-2 text-sm",
    md: "px-6 py-3 text-base",
    lg: "px-8 py-4 text-lg",
  };

  const widthStyle = fullWidth ? "w-full" : "";

  return (
    <button 
      className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${widthStyle} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
};

export default Button;
