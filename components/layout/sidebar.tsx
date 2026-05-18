'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Inbox,
  BookOpen,
  BarChart3,
  ClipboardList,
  Settings,
  Menu,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';

type NavItem = { href: string; label: string; icon: LucideIcon };

const navItems: NavItem[] = [
  { href: '/inbox', label: '受信箱', icon: Inbox },
  { href: '/customer-records', label: '対応記録', icon: ClipboardList },
  { href: '/knowledge', label: 'ナレッジ', icon: BookOpen },
  { href: '/quality', label: '品質分析', icon: BarChart3 },
  { href: '/settings', label: '設定', icon: Settings },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="fixed top-3 left-3 z-50 lg:hidden p-2 rounded-lg bg-white border border-gray-200 shadow-sm"
        aria-label="メニュー"
      >
        {mobileOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-30 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={`
          fixed top-0 left-0 z-40 h-full bg-white border-r border-gray-200
          w-[240px] transition-transform duration-200
          lg:translate-x-0
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <div className="h-16 flex items-center px-5 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center">
              <span className="text-white text-xs font-bold">CS</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">cs-manager</p>
              <p className="text-[10px] text-gray-400 tracking-wider">CUSTOMER SUPPORT</p>
            </div>
          </div>
        </div>

        <nav className="p-3 space-y-1">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== '/' && pathname.startsWith(item.href));
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={`
                  flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm
                  transition-colors duration-150
                  ${
                    isActive
                      ? 'bg-brand-50 text-brand-700 font-medium'
                      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                  }
                `}
              >
                <Icon size={18} strokeWidth={isActive ? 2 : 1.5} />
                <span className="flex-1">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="absolute bottom-0 left-0 right-0 p-3 border-t border-gray-100">
          <p className="text-[11px] text-gray-400 text-center">株式会社オリジンツリー</p>
        </div>
      </aside>
    </>
  );
}
