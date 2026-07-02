'use client';

// 〔これじゃない〕UI は **@originaiagent/feedback の NotThisButton が SoT**。
// cs-manager は薄写し UI を撤去し、package ボタンへ委譲する薄いアダプタのみを持つ。
// アダプタの責務 = ①送信 submit を Server Action へ配線 ②cs-manager 既存の認証切れ復帰
// (auth-recovery) を保全すること。ボタンの見た目/挙動(inline style, phases, done 表示)は package が SoT。
//
// reply-form 側の import (`import NotThisButton from './not-this-button'`) は不変。

import { NotThisButton as FeedbackButton } from '@originaiagent/feedback/button';
import type { SubmitFeedbackRequest } from '@originaiagent/feedback';
import { submitNotThisFeedbackAction } from '../_actions/submit-not-this-feedback';
import { AUTH_EXPIRED_MESSAGE, loginHrefForHere, runAction } from '@/lib/client/auth-recovery';

export default function NotThisButton({
  runId,
  label = 'これじゃない',
}: {
  /** ai_embed_runs.id。空なら描画しない (package 側で条件描画)。 */
  runId: string | null | undefined;
  label?: string;
}) {
  // 既存規約: client から Server Action は runAction() で包み、認証切れ(throw/戻り値なし)を
  // 再ログイン導線へ復帰させる(無限ローディング/汎用エラー固着の防止)。auth-recovery を保全する。
  const submit = async (req: SubmitFeedbackRequest) => {
    const r = await runAction(() => submitNotThisFeedbackAction(req.run_id, req.reason ?? null));
    if (r.authExpired) {
      // 認証切れ: 再ログインへ誘導(既存挙動の保全)。ボタンは安定ラベルを表示。
      if (typeof window !== 'undefined') {
        window.location.href = loginHrefForHere();
      }
      return { ok: false, error: AUTH_EXPIRED_MESSAGE };
    }
    return r.result;
  };

  return <FeedbackButton runId={runId} submit={submit} label={label} />;
}
