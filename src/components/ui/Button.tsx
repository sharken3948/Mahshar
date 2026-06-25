'use client';

import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'accent' | 'secondary' | 'ghost' | 'outline';
  size?: 'sm' | 'md' | 'lg';
}

const variantStyles = {
  primary: 'bg-[#2775CA] hover:bg-[#1E63B5] text-white shadow-sm',
  accent: 'bg-[#00B050] hover:bg-[#008F42] text-white shadow-sm',
  secondary: 'bg-[#FAFAF8] hover:bg-[#F5F5F0] text-[#0D0D0D] border border-[#2775CA]',
  ghost: 'text-[#6B7280] hover:text-[#0D0D0D] hover:bg-[#F5F5F0]',
  outline: 'border border-[#2775CA] text-[#2775CA] hover:bg-[#EBF3FC]',
};

const sizeStyles = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2775CA]',
        variantStyles[variant],
        sizeStyles[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
);

Button.displayName = 'Button';
