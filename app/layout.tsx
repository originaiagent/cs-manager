import './globals.css';
import type { Metadata } from 'next';

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
      <body>{children}</body>
    </html>
  );
}
