export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-24">
      <div className="z-10 max-w-5xl w-full items-center justify-between font-monospace text-sm">
        <h1 className="text-4xl font-bold">cs-manager</h1>
        <p className="mt-4">OriginAI マルチチャネル統合カスタマーサポート + AI改善サイクル</p>
        <div className="mt-8">
          <h2 className="text-2xl font-semibold">Diagnostics</h2>
          <ul className="list-disc ml-6 mt-2">
            <li><a href="/api/_diag/core" className="text-blue-500 underline">Core API Check</a></li>
            <li><a href="/api/_diag/ai" className="text-blue-500 underline">AI API Check</a></li>
          </ul>
        </div>
      </div>
    </main>
  );
}
