import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

interface Item {
  label: string;
  href?: string;
}

export default function Breadcrumb({ items }: { items: Item[] }) {
  return (
    <nav className="flex items-center gap-1.5 text-xs text-gray-500 mb-3" aria-label="Breadcrumb">
      {items.map((it, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5">
            {it.href && !last ? (
              <Link href={it.href} className="hover:text-gray-900 transition-colors">
                {it.label}
              </Link>
            ) : (
              <span className={last ? 'text-gray-900 font-medium' : ''}>{it.label}</span>
            )}
            {!last && <ChevronRight size={12} className="text-gray-300" />}
          </span>
        );
      })}
    </nav>
  );
}
