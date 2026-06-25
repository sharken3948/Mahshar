import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import type { ApiListing } from '@/types';

interface ApiCardProps {
  api: Pick<ApiListing, 'id' | 'name' | 'description' | 'category' | 'price_per_call' | 'payment_model' | 'score' | 'uptime'>;
}

const categoryColors: Record<string, 'blue' | 'success' | 'warning' | 'default'> = {
  ai: 'blue',
  data: 'success',
  finance: 'warning',
  default: 'default',
};

export function ApiCard({ api }: ApiCardProps) {
  const colorVariant = categoryColors[api.category.toLowerCase()] ?? 'default';

  return (
    <Card hover className="flex flex-col gap-4">
      {/* Top row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex-shrink-0 h-10 w-10 rounded-full bg-[#EBF3FC] flex items-center justify-center">
            <span className="text-sm font-bold text-[#2775CA]">{api.name[0]}</span>
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-[#0D0D0D] truncate">{api.name}</h3>
            <Badge variant={colorVariant} className="mt-0.5">{api.category}</Badge>
          </div>
        </div>
        {api.score !== null && (
          <div className="flex-shrink-0 text-right">
            <span className="text-lg font-bold text-[#2775CA]">{api.score}</span>
            <span className="text-xs text-[#6B7280]">/10</span>
          </div>
        )}
      </div>

      {/* Description */}
      <p className="text-sm text-[#6B7280] line-clamp-2">{api.description}</p>

      {/* Payment model */}
      <div className="flex flex-wrap gap-2">
        <Badge variant={api.payment_model === 'pay-per-call' ? 'blue' : 'green'}>
          {api.payment_model === 'pay-per-call' ? 'Pay-per-call' : api.payment_model === 'credits' ? 'Credits' : 'Both'}
        </Badge>
        {api.uptime !== null && (
          <Badge variant={api.uptime >= 99 ? 'success' : api.uptime >= 95 ? 'warning' : 'error'}>
            {api.uptime}% uptime
          </Badge>
        )}
      </div>

      {/* Bottom row */}
      <div className="flex items-center justify-between mt-auto pt-3 border-t border-[#2775CA]">
        <div>
          <span className="text-lg font-semibold text-[#0D0D0D]">${api.price_per_call.toFixed(4)}</span>
          <span className="text-xs text-[#6B7280] ml-1">USDC / call</span>
        </div>
        <Link href="/buyer">
          <Button size="sm" variant="accent">Use API</Button>
        </Link>
      </div>
    </Card>
  );
}
