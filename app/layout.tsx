import './globals.css';
import type { Metadata } from 'next';
import Sidebar from '@/components/layout/sidebar';

export const metadata: Metadata = {
  title: 'cs-manager',
  description: 'OriginAI マルチチャネル統合カスタマーサポート + AI改善サイクル',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>
        <Sidebar />
        <main className="lg:ml-[240px] min-h-screen bg-gray-50/50">
          <div className="p-4 lg:p-8 pt-16 lg:pt-8">{children}</div>
        </main>
      </body>
    </html>
  );
}
