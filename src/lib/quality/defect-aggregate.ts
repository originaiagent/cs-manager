/**
 * 不良発生率 集計ライブラリ (純関数・vitest 対象)
 *
 * 入力の取得は呼び出し側 (/quality/defect-rate page) が行い、ここでは I/O しない:
 *   - defect tickets (case_category='defect') + AI 分類原因 (ticket_defect_causes)
 *   - defect CSR (customer_service_records の不良系行)
 *   - FBA 不良返品 (return-reasons.ts でマップ済のもののみ)
 *   - 製品解決情報 (ASIN→子 product_id / 子 product_id→親 group_id)
 *   - 期間販売数 (sales-resolver.ts の解決結果)
 *
 * 案件 (case) 統合ルール (defect-rate-design.md C2-1):
 *   1. CSR.ticket_id が defect ticket に一致 → 同一案件に統合
 *      (原因ラベルは和集合。製品情報は CSR 優先 = 手入力で親/バリエーションが正確)
 *   2. FBA 返品は order_id が既存案件の注文番号と一致 → 同一案件に統合 (原因和集合)。
 *      不一致 → 独立案件 (件数 = quantity, 最低 1)
 *   3. CSR 単独 / ticket 単独はそれぞれ 1 案件
 *   4. CSR.defect_type 自由文字列は cause ラベルとしてそのまま使う (major は 'other' 扱い、
 *      ただし ticket 側 AI cause と同一ラベルなら AI 側の major を優先)
 *
 * 不良率 = 案件ユニーク数 ÷ 期間販売数 (全モール)。
 * 原因別内訳は 1 案件複数原因で重複可のため合計 ≠ 不良数。
 */

import { DEFECT_TYPE_LABELS } from '@/lib/format';
import { normalizeMajorCategory, type MajorCategory } from './defect-taxonomy';

// ---------------------------------------------------------------------------
// 入力型
// ---------------------------------------------------------------------------

export interface TicketCauseInput {
  label: string;
  major: MajorCategory;
}

/** tickets (case_category='defect') 1 行分 */
export interface DefectTicketInput {
  id: string;
  /** 子 products.id (text)。null = 製品未特定 (CSR 統合で解決され得る) */
  product_id: string | null;
  /** 旧 enum (AI causes が無い legacy ticket のフォールバック) */
  defect_type: string | null;
  /** ticket_defect_causes (AI 分類済み原因) */
  causes: TicketCauseInput[];
  /** channel_meta から抽出した注文番号 (extractOrderNumberFromChannelMeta) */
  order_number: string | null;
  channel_code: string | null;
}

/** customer_service_records の不良系 1 行分 */
export interface DefectCsrInput {
  id: string;
  ticket_id: string | null;
  /** 親 group_id (PR-EF 以降)。legacy は子 products.id の場合あり */
  product_id: string | null;
  /** 子 products.id (バリエーション) */
  variation_id: string | null;
  variation_text: string | null;
  /** 自由文字列の不良内容 (cause ラベルとしてそのまま使う) */
  defect_type: string | null;
  order_number: string | null;
  order_channel: string | null;
}

/** FBA 返品のうち return-reasons.ts で不良系にマップされた 1 行分 */
export interface FbaDefectReturnInput {
  orderId: string | null;
  asin: string | null;
  quantity: number | null;
  causeLabel: string;
  majorCategory: MajorCategory;
}

/** 製品解決情報 (呼び出し側で Core lookup 済み) */
export interface ProductResolutionInput {
  /** ASIN → 子 product_id */
  asinToChild: Map<string, string>;
  /** 子 product_id → 親 group_id (未解決の子は含めない = 子 id を group 扱いにフォールバック) */
  childToGroup: Map<string, string>;
}

/** 期間販売数 (sales-resolver.ts の解決結果) */
export interface SalesUnitsInput {
  /** ec-manager から取得できたか (false = 分母なし、rate は全行 null) */
  available: boolean;
  /** 親 group_id → units 合計 */
  groupUnits: Map<string, number>;
  /** 子 product_id → units 合計 */
  variationUnits: Map<string, number>;
  /** 製品解決できなかった units 合計 (UI 注記用にそのまま返す) */
  unmappedUnits: number;
}

// ---------------------------------------------------------------------------
// 出力型
// ---------------------------------------------------------------------------

export interface DefectAggRow {
  /** 親 group_id (親未解決の子は子 id をそのまま group 扱い = legacy フォールバック) */
  group_id: string;
  /** バリエーション行のみ: 子 products.id (不明時 null) */
  variation_child_id: string | null;
  /** バリエーション行のみ: CSR 手入力のバリエーション表示名 */
  variation_text: string | null;
  /** 不良案件ユニーク数 (FBA 独立案件は quantity 分) */
  total_cases: number;
  /** 原因ラベル → 案件数 (1 案件が同一 cause を複数回持っても 1 案件分) */
  cause_breakdown: Record<string, number>;
  /** 原因ラベル → 大分類 (AI/enum/FBA 由来を CSR 自由文字列の 'other' より優先) */
  cause_majors: Record<string, MajorCategory>;
  /** ソース別の案件数内訳 (1 案件が複数ソース由来なら双方に計上 = 合計 ≠ total_cases あり得る) */
  sources: { tickets: number; csr: number; fba: number };
  /** 期間販売数 (null = 販売数取得不可) */
  sales_units: number | null;
  /** total_cases / sales_units (sales_units が無い/0 なら null = UI で '-') */
  rate: number | null;
}

export interface DefectAggregateResult {
  /** 親 group 単位の行 (rate 降順) */
  parentRows: DefectAggRow[];
  /** バリエーション (子) 単位の行 (rate 降順) */
  variationRows: DefectAggRow[];
  /** 未紐付け情報 (UI 注記用) */
  unmapped: {
    /** 製品解決できなかった販売数合計 (SalesUnitsInput.unmappedUnits の pass-through) */
    salesUnits: number;
    /** ASIN が製品解決できなかった FBA 不良返品の件数 (quantity 換算) */
    fbaReturns: number;
    /** 製品未特定のまま残った ticket/CSR 案件数 */
    defectCases: number;
  };
}

// ---------------------------------------------------------------------------
// 注文番号抽出 (draft-rag route の extractOrderNumber と同じ流儀)
// ---------------------------------------------------------------------------

/**
 * channel_meta(jsonb) から注文番号を best-effort 抽出。専用カラムは無い。
 * キー命名は adapter ごとに揺れる (order_number / orderNumber / orderNo / order_id 等)
 * ため、英数字以外を除去して lower-case 化した正規化キーで照合する
 * (app/api/tickets/[id]/draft-rag/route.ts extractOrderNumber と同一ロジック)。
 */
const ORDER_NUMBER_NORMALIZED_KEYS = ['ordernumber', 'orderno', 'orderid'] as const;

function normalizeMetaKey(k: string): string {
  return k.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function extractOrderNumberFromChannelMeta(channelMeta: unknown): string | null {
  if (!channelMeta || typeof channelMeta !== 'object') return null;
  const normalized = new Map<string, unknown>();
  for (const [k, v] of Object.entries(channelMeta as Record<string, unknown>)) {
    const nk = normalizeMetaKey(k);
    if (!normalized.has(nk)) normalized.set(nk, v);
  }
  for (const key of ORDER_NUMBER_NORMALIZED_KEYS) {
    const v = normalized.get(key);
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 集計本体
// ---------------------------------------------------------------------------

/** structured = AI 分類 / 旧 enum / FBA reason 由来 (major が信頼できる)。CSR 自由文字列は false */
interface CaseCauseInfo {
  major: MajorCategory;
  structured: boolean;
}

/** 統合後の 1 案件 */
interface DefectCase {
  groupId: string | null;
  variationChildId: string | null;
  variationText: string | null;
  causes: Map<string, CaseCauseInfo>;
  orderNumbers: Set<string>;
  /** 案件数 (FBA 独立案件は quantity、その他は 1) */
  count: number;
  src: { tickets: number; csr: number; fba: number };
}

/** cause 追加 (ルール 4: 同一ラベルは structured (AI 等) の major を優先) */
function addCause(c: DefectCase, label: string, major: MajorCategory, structured: boolean): void {
  const l = label.trim();
  if (!l) return;
  const existing = c.causes.get(l);
  if (!existing || (!existing.structured && structured)) {
    c.causes.set(l, { major, structured });
  }
}

function trimOrNull(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

interface RowAcc {
  group: string;
  variationChildId: string | null;
  variationText: string | null;
  total: number;
  causeCounts: Map<string, number>;
  causeMajors: Map<string, CaseCauseInfo>;
  src: { tickets: number; csr: number; fba: number };
}

function newRowAcc(group: string, variationChildId: string | null, variationText: string | null): RowAcc {
  return {
    group,
    variationChildId,
    variationText,
    total: 0,
    causeCounts: new Map(),
    causeMajors: new Map(),
    src: { tickets: 0, csr: 0, fba: 0 },
  };
}

function addCaseToRow(acc: RowAcc, c: DefectCase): void {
  acc.total += c.count;
  for (const [label, info] of c.causes) {
    // 1 案件内の同一 cause は Map 化で既に 1 回のみ → 案件数 (count) 分だけ加算
    acc.causeCounts.set(label, (acc.causeCounts.get(label) ?? 0) + c.count);
    const ex = acc.causeMajors.get(label);
    if (!ex || (!ex.structured && info.structured)) acc.causeMajors.set(label, info);
  }
  if (c.src.tickets > 0) acc.src.tickets += c.count;
  if (c.src.csr > 0) acc.src.csr += c.count;
  if (c.src.fba > 0) acc.src.fba += c.count;
  if (!acc.variationText && c.variationText) acc.variationText = c.variationText;
}

function toRow(acc: RowAcc, salesUnits: number | null): DefectAggRow {
  return {
    group_id: acc.group,
    variation_child_id: acc.variationChildId,
    variation_text: acc.variationText,
    total_cases: acc.total,
    cause_breakdown: Object.fromEntries(acc.causeCounts),
    cause_majors: Object.fromEntries(
      Array.from(acc.causeMajors, ([label, info]) => [label, info.major]),
    ),
    sources: acc.src,
    sales_units: salesUnits,
    rate: salesUnits != null && salesUnits > 0 ? acc.total / salesUnits : null,
  };
}

/** rate 降順 (null は最後) → 案件数降順 → group_id / variation 昇順 */
function compareRows(a: DefectAggRow, b: DefectAggRow): number {
  const ar = a.rate ?? -1;
  const br = b.rate ?? -1;
  if (br !== ar) return br - ar;
  if (b.total_cases !== a.total_cases) return b.total_cases - a.total_cases;
  if (a.group_id !== b.group_id) return a.group_id.localeCompare(b.group_id);
  const av = a.variation_child_id ?? a.variation_text ?? '';
  const bv = b.variation_child_id ?? b.variation_text ?? '';
  return av.localeCompare(bv);
}

export function aggregateDefectCases(input: {
  tickets: DefectTicketInput[];
  csrs: DefectCsrInput[];
  fbaReturns: FbaDefectReturnInput[];
  resolution: ProductResolutionInput;
  sales: SalesUnitsInput;
}): DefectAggregateResult {
  const { tickets, csrs, fbaReturns, resolution, sales } = input;

  // 親未解決の子は子 id をそのまま group 扱い (sales-resolver と同一のフォールバック規則)
  const groupOf = (child: string | null): string | null =>
    child ? (resolution.childToGroup.get(child) ?? child) : null;

  const cases: DefectCase[] = [];
  const caseByTicketId = new Map<string, DefectCase>();

  // --- ルール 3: ticket 1 行 = 1 案件 ---
  for (const t of tickets) {
    const child = trimOrNull(t.product_id);
    const c: DefectCase = {
      groupId: groupOf(child),
      variationChildId: child,
      variationText: null,
      causes: new Map(),
      orderNumbers: new Set(),
      count: 1,
      src: { tickets: 1, csr: 0, fba: 0 },
    };
    if (t.causes.length > 0) {
      for (const cause of t.causes) addCause(c, cause.label, cause.major, true);
    } else {
      // AI causes 未付与の legacy ticket は旧 defect_type enum を日本語化して cause 扱い
      const dt = trimOrNull(t.defect_type);
      if (dt) addCause(c, DEFECT_TYPE_LABELS[dt] ?? dt, normalizeMajorCategory(dt), true);
    }
    const on = trimOrNull(t.order_number);
    if (on) c.orderNumbers.add(on);
    cases.push(c);
    caseByTicketId.set(t.id, c);
  }

  // --- ルール 1: CSR.ticket_id 一致は同一案件へ統合 / 単独 CSR は 1 案件 ---
  for (const r of csrs) {
    const linked = r.ticket_id ? caseByTicketId.get(r.ticket_id) : undefined;
    let target: DefectCase;
    if (linked) {
      target = linked;
      target.src.csr += 1;
    } else {
      target = {
        groupId: null,
        variationChildId: null,
        variationText: null,
        causes: new Map(),
        orderNumbers: new Set(),
        count: 1,
        src: { tickets: 0, csr: 1, fba: 0 },
      };
      cases.push(target);
    }
    // 製品情報は CSR 優先 (手入力で親/バリエーションが正確)。CSR 側が空なら ticket 由来を維持
    const csrGroup = trimOrNull(r.product_id);
    if (csrGroup) target.groupId = csrGroup;
    const csrChild = trimOrNull(r.variation_id);
    if (csrChild) target.variationChildId = csrChild;
    const csrText = trimOrNull(r.variation_text);
    if (csrText) target.variationText = csrText;
    // ルール 4: 自由文字列 defect_type はそのまま cause ラベル (major='other'、AI 側優先)
    const dt = trimOrNull(r.defect_type);
    if (dt) addCause(target, dt, 'other', false);
    const on = trimOrNull(r.order_number);
    if (on) target.orderNumbers.add(on);
  }

  // --- ルール 2: FBA 返品は注文番号一致で統合、不一致は独立案件 (件数 = quantity) ---
  const orderIndex = new Map<string, DefectCase>();
  for (const c of cases) {
    for (const on of c.orderNumbers) {
      if (!orderIndex.has(on)) orderIndex.set(on, c);
    }
  }
  let unmappedFbaReturns = 0;
  for (const f of fbaReturns) {
    const orderId = trimOrNull(f.orderId);
    const qtyRaw = Number(f.quantity ?? 1);
    const qty = Number.isFinite(qtyRaw) && qtyRaw >= 1 ? Math.floor(qtyRaw) : 1;
    const asin = trimOrNull(f.asin);
    const child = asin ? (resolution.asinToChild.get(asin) ?? null) : null;
    const matched = orderId ? orderIndex.get(orderId) : undefined;
    if (matched) {
      matched.src.fba += 1;
      addCause(matched, f.causeLabel, f.majorCategory, true);
      // 製品未特定の案件 (実データでは CSR の product 未入力が大半) は
      // FBA 側の ASIN 解決で製品を補完する (案件は増やさず帰属先だけ確定)
      if (!matched.groupId && child) {
        matched.groupId = groupOf(child);
        if (!matched.variationChildId) matched.variationChildId = child;
      }
      continue;
    }
    if (!child) {
      // ASIN 解決不可 → 行にせず「未紐付け返品」として可視化 (quantity 換算)
      unmappedFbaReturns += qty;
      continue;
    }
    const c: DefectCase = {
      groupId: groupOf(child),
      variationChildId: child,
      variationText: null,
      causes: new Map(),
      orderNumbers: new Set(orderId ? [orderId] : []),
      count: qty,
      src: { tickets: 0, csr: 0, fba: 1 },
    };
    addCause(c, f.causeLabel, f.majorCategory, true);
    cases.push(c);
    // 同一注文の複数返品行 (別 SKU / 別 reason) は同一案件へ統合する
    if (orderId && !orderIndex.has(orderId)) orderIndex.set(orderId, c);
  }

  // --- 行化: 親 group 単位 + バリエーション単位 ---
  const parentAcc = new Map<string, RowAcc>();
  const variationAcc = new Map<string, RowAcc>();
  let unresolvedDefectCases = 0;

  const variationKeyOf = (c: { variationChildId: string | null; variationText: string | null }) =>
    c.variationChildId ?? (c.variationText ? `text:${c.variationText}` : '(unknown)');

  for (const c of cases) {
    if (!c.groupId) {
      unresolvedDefectCases += c.count;
      continue;
    }
    let p = parentAcc.get(c.groupId);
    if (!p) {
      p = newRowAcc(c.groupId, null, null);
      parentAcc.set(c.groupId, p);
    }
    addCaseToRow(p, c);
    // 親行に variationText を混ぜない (addCaseToRow が補完するのはバリエーション行用)
    p.variationText = null;

    const vk = `${c.groupId}|${variationKeyOf(c)}`;
    let v = variationAcc.get(vk);
    if (!v) {
      v = newRowAcc(c.groupId, c.variationChildId, c.variationText);
      variationAcc.set(vk, v);
    }
    addCaseToRow(v, c);
  }

  // --- 販売数を紐付け + 不良ゼロの sales-only 行を補完 ---
  if (sales.available) {
    for (const groupId of sales.groupUnits.keys()) {
      if (!parentAcc.has(groupId)) {
        parentAcc.set(groupId, newRowAcc(groupId, null, null));
      }
    }
    for (const child of sales.variationUnits.keys()) {
      const group = groupOf(child);
      if (!group) continue;
      const vk = `${group}|${child}`;
      if (!variationAcc.has(vk)) {
        variationAcc.set(vk, newRowAcc(group, child, null));
      }
    }
  }

  const parentRows = Array.from(parentAcc.values())
    .map((acc) =>
      toRow(acc, sales.available ? (sales.groupUnits.get(acc.group) ?? 0) : null),
    )
    .sort(compareRows);
  const variationRows = Array.from(variationAcc.values())
    .map((acc) =>
      toRow(
        acc,
        sales.available
          ? acc.variationChildId
            ? (sales.variationUnits.get(acc.variationChildId) ?? 0)
            : 0
          : null,
      ),
    )
    .sort(compareRows);

  return {
    parentRows,
    variationRows,
    unmapped: {
      salesUnits: sales.available ? sales.unmappedUnits : 0,
      fbaReturns: unmappedFbaReturns,
      defectCases: unresolvedDefectCases,
    },
  };
}
