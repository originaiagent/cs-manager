/**
 * 集計定義パネル — 工場エビデンス化 C3b-4
 *
 * 「この数字の定義」をページ下部に折りたたみ (details/summary) で常設する。
 * 責任区分マッピング・除外理由コードはコード上の定義 (defect-taxonomy /
 * return-reasons) をそのまま import して描画し、定義書とコードの乖離を防ぐ。
 * 静的 JSX のみ (details/summary はブラウザ標準動作なので client 化不要)。
 */

import {
  MAJOR_CATEGORIES,
  MAJOR_CATEGORY_LABELS,
  RESPONSIBILITY_LABELS,
  FBA_REASON_RESPONSIBILITY,
  MAJOR_RESPONSIBILITY,
} from '@/lib/quality/defect-taxonomy';
import { NON_DEFECT_RETURN_REASONS } from '@/lib/quality/return-reasons';

function DefinitionRow({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2">
      <dt className="text-gray-500 font-medium">{term}</dt>
      <dd className="text-gray-700">{children}</dd>
    </div>
  );
}

export default function DefinitionsPanel() {
  return (
    <details
      className="mt-6 rounded-xl border border-gray-200 bg-white"
      data-testid="definitions-panel"
    >
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-xl">
        この数字の定義 (分母・分子・責任区分・基準・除外)
      </summary>
      <div className="border-t border-gray-100 px-4 py-4 text-xs leading-relaxed">
        <dl className="space-y-3">
          <DefinitionRow term="分母 (販売数)">
            ec-manager の実売数 (全モール合算)。注文日 (order_date) 軸で期間集計する。
            基準が「発生日」のときも分母は注文日軸のまま = 近似値
            (発生日軸の販売数は存在しないため)。
          </DefinitionRow>
          <DefinitionRow term="分子 (不良数)">
            不良案件のユニーク数。チケット (AI 分類 defect) + 対応記録
            (不良系の対応種別 or 不良内容入力あり) + FBA 不良返品の 3 ソースを、
            注文番号・チケット紐付けで同一案件に名寄せして数える
            (FBA 独立案件は数量分)。
          </DefinitionRow>
          <DefinitionRow term="原因">
            1 案件に複数の原因が付き得る (例: 傷 + 部品欠品)。原因別内訳の合計は
            不良数と一致しない。
          </DefinitionRow>
          <DefinitionRow term="基準">
            「発生日」(既定) はクレーム受信日・対応記録日・FBA 返品日が期間内の案件を数える。
            「注文日」は注文日が期間内の案件を数える (分母の注文日軸と整合する基準)。
            注文日は楽天 = 注文番号から直接取得 / Amazon = 財務イベントの計上日 (≒出荷日) の近似。
            注文日が解決できない案件は発生日で代用し、件数を注記する。
          </DefinitionRow>
          <DefinitionRow term="責任区分">
            原因単位で下表のとおり機械判定し、案件の代表値は 工場起因 &gt; 配送・倉庫起因 &gt;
            自社起因 &gt; 要精査 の優先順で決める (1 つでも工場起因があれば工場起因の案件)。
          </DefinitionRow>
        </dl>

        {/* 責任区分マッピング表 (コードの定義をそのまま描画) */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <p className="text-[11px] font-medium text-gray-500 mb-1.5">
              FBA 返品理由コード → 責任区分 (最優先)
            </p>
            <table className="text-xs">
              <tbody>
                {Object.entries(FBA_REASON_RESPONSIBILITY).map(([code, resp]) => (
                  <tr key={code} className="text-gray-700">
                    <td className="pr-4 py-0.5 font-mono text-[10px]">{code}</td>
                    <td className="py-0.5">{RESPONSIBILITY_LABELS[resp]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <p className="text-[11px] font-medium text-gray-500 mb-1.5">
              大分類 → 責任区分 (FBA 理由コードが無い場合)
            </p>
            <table className="text-xs">
              <tbody>
                {MAJOR_CATEGORIES.map((major) => (
                  <tr key={major} className="text-gray-700">
                    <td className="pr-4 py-0.5">{MAJOR_CATEGORY_LABELS[major]}</td>
                    <td className="py-0.5">{RESPONSIBILITY_LABELS[MAJOR_RESPONSIBILITY[major]]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[10px] text-gray-400 mt-1.5">
              ※ 破損・傷 → 工場起因 は v1 の割り切り (配送起因の破損は FBA
              理由コードがある場合のみ配送・倉庫起因に切り分けられる)。
            </p>
          </div>
        </div>

        {/* 顧客都合の除外理由コード群 */}
        <div className="mt-4">
          <p className="text-[11px] font-medium text-gray-500 mb-1.5">
            除外 (顧客都合の FBA 返品理由コード — 不良に数えない)
          </p>
          <p className="font-mono text-[10px] text-gray-500 break-words">
            {Array.from(NON_DEFECT_RETURN_REASONS).join(' / ')}
          </p>
          <p className="text-[10px] text-gray-400 mt-1.5">
            ※ 上記以外の未知の理由コードは「未分類」として注記し、不良にも顧客都合にも数えない。
          </p>
        </div>
      </div>
    </details>
  );
}
