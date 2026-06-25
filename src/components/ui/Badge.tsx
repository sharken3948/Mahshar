import { type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'warning' | 'error' | 'blue' | 'green';
}

const variantStyles = {
  default: 'bg-[#FAFAF8] text-[#6B7280] border-[#2775CA]',
  success: 'bg-[#F0FDF4] text-[#16A34A] border-[#BBF7D0]',
  warning: 'bg-amber-50 text-amber-600 border-amber-200',
  error: 'bg-red-50 text-red-600 border-red-200',
  blue: 'bg-[#EBF3FC] text-[#2775CA] border-[#BFDBFE]',
  green: 'bg-[#F0FDF9] text-[#00B050] border-[#BBF7D0]',
};

export function Badge({ variant = 'default', className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
        variantStyles[variant],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
