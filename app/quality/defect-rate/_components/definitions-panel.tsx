/**
 * 集計定義パネル — 症状別ハンドオフ (defect-symptom-handoff)
 *
 * 「この数字の意味」をページ下部に折りたたみ (details/summary) で常設する。
 * トム承認済みモック仕様の4行のみを表示する (責任区分マッピング表は撤去済み)。
 * 静的 JSX のみ (details/summary はブラウザ標準動作なので client 化不要)。
 */

export default function DefinitionsPanel() {
  return (
    <details
      className="mt-6 rounded-xl border border-gray-200 bg-white"
      data-testid="definitions-panel"
    >
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-xl">
        この数字の意味
      </summary>
      <div className="border-t border-gray-100 px-4 py-4 text-xs leading-relaxed">
        <ul className="list-disc space-y-2 pl-5 text-gray-700">
          <li>
            <strong className="font-medium text-gray-900">不良率</strong> = 不良案件数 ÷
            期間販売数（全モール合計の実売数）
          </li>
          <li>
            <strong className="font-medium text-gray-900">不良案件</strong> =
            お客様からの申告（問い合わせ・対応記録）と FBA返品を、注文番号でまとめて1件と数えたもの
          </li>
          <li>
            <strong className="font-medium text-gray-900">症状</strong> =
            申告内容から判定。1件に複数の症状が付くため、症状の合計は不良数と一致しない
          </li>
          <li>配送中の破損・顧客都合の返品は不良に数えない</li>
        </ul>
      </div>
    </details>
  );
}
