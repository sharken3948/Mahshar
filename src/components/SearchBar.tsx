'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

interface SearchBarProps {
  defaultValue?: string;
  placeholder?: string;
}

export function SearchBar({ defaultValue = '', placeholder = 'Find an API using natural language...' }: SearchBarProps) {
  const [query, setQuery] = useState(defaultValue);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    startTransition(() => {
      router.push('/buyer');
    });
  }

  return (
    <form onSubmit={handleSearch} className="relative w-full max-w-2xl">
      <div className="relative flex items-center">
        <svg
          className="absolute left-4 h-5 w-5 text-[#6B7280] pointer-events-none"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-xl border border-[#E2E4E9] bg-[#FAFAF8] pl-12 pr-28 py-3.5 text-sm text-[#0D0D0D] placeholder-[#6B7280] focus:border-[#2775CA] focus:outline-none focus:ring-1 focus:ring-[#2775CA] transition-colors"
        />
        <button
          type="submit"
          disabled={isPending || !query.trim()}
          className="absolute right-2 rounded-lg bg-[#00B050] px-4 py-2 text-sm font-medium text-white hover:bg-[#008F42] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isPending ? 'Searching...' : 'Search'}
        </button>
      </div>
    </form>
  );
}
