import Link from "next/link";

export function SiteFooter() {
  return (
    <footer>
      <p>Ready to become something specific.</p>
      <nav className="legal-links" aria-label="法務情報" lang="ja">
        <Link href="/terms">利用規約</Link>
        <Link href="/privacy">プライバシーポリシー</Link>
      </nav>
    </footer>
  );
}
