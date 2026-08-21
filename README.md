# Web Template

Codex を主担当、Claude を独立評価者または相談者として使う、個人向け Web アプリ開発テンプレートです。

標準構成は Next.js App Router、TypeScript、Supabase、Vercel、Cloudflare DNS です。GitHub の **Template repository** として利用し、生成後のプロジェクトごとに仕様、環境、外部サービスの所有者を確定します。

## 現在地

このリポジトリは Issue 単位で構築中です。実装順と完了条件は [GitHub Issues](https://github.com/yuto1201/Web-Template/issues) を正本とし、リポジトリ内では次を参照してください。

- [AGENTS.md](AGENTS.md): 全モデル共通の実行規約
- [specs/README.md](specs/README.md): 仕様の正本と更新ルール
- [docs/authority.md](docs/authority.md): アカウントと外部操作の権限境界
- [docs/workflow.md](docs/workflow.md): Issue から squash merge までの標準手順
- [docs/security.md](docs/security.md): 秘密情報と Claude 実行ガード
- [docs/verification.md](docs/verification.md): 必須検証と証跡

## ローカル確認

Node.js 24 と npm 11 を使います。

```powershell
npm ci
npm run dev
```

初回起動前に `.env.example` を `.env.local` にコピーし、対象プロジェクトの公開可能な Supabase URL と publishable key を設定します。`NEXT_PUBLIC_` 変数には service-role key やプロバイダートークンを入れないでください。

全検証は次のコマンドで実行します。

```powershell
npm run check
npm run test:e2e
```

`npm run check` はポリシー、lint、型、単体テストに加え、Server-only モジュールの誤 import が実際にビルドを拒否することと、ブラウザ用 bundle に秘密情報パターンが含まれないことを確認します。

Supabaseのmigration、RLS、grant、生成型はDockerを使う別検証で確認します。

```powershell
npm run db:verify
npm run db:stop
```

`db:verify` は固定CLIでlocal Postgresを起動し、空DB reset、schema lint、pgTAP否定テスト、生成型比較を行います。Docker daemonへ接続できない場合は`NOT RUN`とexit code 2を返し、成功として扱いません。標準ポートを使う他プロジェクトを妨げないよう、このテンプレートは`5532x`帯を使用します。

ESLint 9 と TypeScript 6 は Next.js 16.3.1 のlint構成（`typescript-eslint` を含む）が宣言する互換範囲に固定しています。新しいmajorへ上げる場合は、`npm ls` のpeer dependencyと全チェックを同時に確認します。

生成されたエージェント定義を更新する場合は、`config/agents.json` と `docs/agent-contracts/` を変更してから次を実行します。

```powershell
npm run generate
npm run check
```

## 安全境界

Supabase、Vercel、Cloudflare、GitHub など、個人アカウントに認証された外部操作は Codex のみが実行します。Claude はローカル実装と読み取り評価に利用できますが、外部サービスの認証、照会、変更、デプロイは行いません。詳細は [docs/authority.md](docs/authority.md) を参照してください。
