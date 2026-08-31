import type { Metadata } from "next";
import { LegalDocument } from "@/components/legal-document";

export const metadata: Metadata = {
  title: "利用規約 | 要確認のひな形",
  description: "サイトごとの内容確認と確定が必要な利用規約のひな形です。",
  robots: { index: false, follow: false },
};

export default function TermsPage() {
  return (
    <LegalDocument title="利用規約">
      <section>
        <h2>運営者とお問い合わせ</h2>
        <p>サービス名、運営者の正式名称、必要な所在地・代表者情報、実際に連絡できる窓口を記載してください。いずれも現時点では未確定です。</p>
      </section>
      <section>
        <h2>サービス内容と利用条件</h2>
        <p>提供する機能、対象ユーザー、対象地域、年齢条件、登録の要否を具体化してください。規約が適用される範囲と、利用者へ提示・同意確認する方法も決定してください。</p>
      </section>
      <section>
        <h2>アカウントと禁止事項</h2>
        <p>アカウント管理がある場合の責任分担、不正アクセスや第三者の権利侵害などの禁止行為、違反時の対応をサービスに合わせて定めてください。</p>
      </section>
      <section>
        <h2>料金・解約と投稿内容</h2>
        <p>有料機能がある場合は料金、支払時期、更新、解約・返金条件を明示してください。投稿機能がある場合は権利の帰属と利用許諾の範囲を確認し、該当しない機能についても実態を記載してください。</p>
      </section>
      <section>
        <h2>サービス変更・停止と責任範囲</h2>
        <p>保守、機能変更、利用停止、終了の条件と通知方法を決めてください。免責や損害賠償の条項は適用法令とサービスのリスクに合わせて確認し、一律の免責をそのまま転用しないでください。</p>
      </section>
      <section>
        <h2>個人情報・規約の改定と紛争対応</h2>
        <p>個人情報の扱いをプライバシーポリシーと一致させてください。改定の通知・適用方法、施行日・最終更新日、準拠法・紛争解決方法を対象地域に合わせて確定してください。</p>
      </section>
    </LegalDocument>
  );
}
