import React from 'react';
import { User } from 'lucide-react';

interface AvatarProps {
  src?: string | null;
  name?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  alt?: string;
}

const sizeClasses = {
  xs: 'w-6 h-6 text-xs',
  sm: 'w-8 h-8 text-sm',
  md: 'w-10 h-10 text-base',
  lg: 'w-12 h-12 text-lg',
  xl: 'w-16 h-16 text-2xl',
};

/**
 * Avatar component with smart fallback:
 * 1. If there is an image → display the image
 * 2. If there is a name → display initials
 * 3. If there is nothing → display the user icon
 */
export default function Avatar({
  src,
  name,
  size = 'md',
  className = '',
  alt,
}: AvatarProps) {
  const [imageError, setImageError] = React.useState(false);

  // Generate initials from name
  const getInitials = (fullName: string): string => {
    const parts = fullName.trim().split(' ');
    if (parts.length === 1) {
      return parts[0].charAt(0).toUpperCase();
    }
    // Get the first letter of the first and last words (full name)
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  };

  // Generate consistent color based on name
  const getColorFromName = (name: string): string => {
    const colors = [
      'bg-brand-primary',
      'bg-brand-accent',
      'bg-status-success',
      'bg-status-warning',
      'bg-status-info',
      'bg-status-error',
    ];
    // Simple hash function to get consistent color for same name
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  const sizeClass = sizeClasses[size];
  const baseClasses = `${sizeClass} rounded-full flex items-center justify-center ${className}`;

  // Case 1: There is an image and there is no error
  if (src && !imageError) {
    const imageUrl = src.startsWith('http')
      ? src
      : `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333'}${src}`;

    return (
      <img
        src={imageUrl}
        alt={alt || name || 'Avatar'}
        className={`${baseClasses} object-cover border-2 border-surface-border`}
        onError={() => setImageError(true)}
      />
    );
  }

  // Case 2: There is a name → display initials
  if (name) {
    const initials = getInitials(name);
    const colorClass = getColorFromName(name);
    return (
      <div className={`${baseClasses} ${colorClass} text-white font-medium`}>
        {initials}
      </div>
    );
  }

  // Case 3: Display fallback icon
  const iconSize = size === 'xs' ? 12 : size === 'sm' ? 14 : size === 'md' ? 16 : size === 'lg' ? 20 : 24;
  return (
    <div className={`${baseClasses} bg-surface-page text-text-muted border border-surface-border`}>
      <User size={iconSize} />
    </div>
  );
}
