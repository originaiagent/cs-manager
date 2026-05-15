'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Tab {
  href: string;
  label: string;
}

interface Props {
  tabs: Tab[];
}

export default function TabNav({ tabs }: Props) {
  const pathname = usePathname();
  return (
    <nav className="border-b border-gray-200 mb-6">
      <ul className="flex flex-wrap gap-1 -mb-px">
        {tabs.map((t) => {
          const active = pathname === t.href || pathname.startsWith(t.href + '/');
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                className={`inline-flex items-center px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  active
                    ? 'border-brand-500 text-brand-700'
                    : 'border-transparent text-gray-500 hover:text-gray-900'
                }`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
