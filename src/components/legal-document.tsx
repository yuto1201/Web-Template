import type { ReactNode } from "react";
import Link from "next/link";

export function LegalDocument({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="legal-document" lang="ja">
      <Link className="text-action" href="/" prefetch={false}>ホームへ戻る</Link>
      <header className="legal-heading">
        <p className="eyebrow">公開前の確認が必要です</p>
        <h1>{title}</h1>
        <p>施行日・最終更新日：未確定</p>
      </header>
      <aside className="legal-draft" role="note" aria-label="ひな形について">
        <strong>未確認のひな形 — 公開用の確定文書ではありません。</strong>
        <p>
          以下はサイト運営者が文書を作成するための確認項目です。実際のサービス内容に合わせて
          各項目を確定し、必要に応じて専門家の確認を受けてから公開してください。
          法的な助言や適法性の保証を提供するものではありません。
        </p>
      </aside>
      <div className="legal-sections">{children}</div>
    </main>
  );
}
