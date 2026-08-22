# Web Template

Codex local、Claude local、Cursor Cloud の3つの実行 surface を用途別に使う、個人向け Web アプリ開発の guarded golden template です。標準構成は Next.js App Router、strict TypeScript、Supabase、Vercel、Cloudflare DNS です。実行 surface と実際に応答した model family は別々に記録します。

このリポジトリは最小のコード断片ではありません。生成後のアプリにも、Auth/RLS、秘密情報境界、Preview/Production、DNS、反対モデル評価を実際に検査するガードを残します。サンプル業務機能は含めず、ライブ Supabase・Vercel・Cloudflare の有効化は選択可能な別工程です。

## GitHub Template から始める

1. GitHub の **Use this template** から新しいリポジトリを作成して clone します。
2. `template-init.example.json` を `.template-init.json` にコピーし、アプリ名、slug、生成先 GitHub、ローカルポート、予定する公開 URL と Cloudflare zone を編集します。
3. 初期化し、同じ入力で再実行できることを確認します。

```powershell
npm run template:init -- --config .template-init.json
npm run template:init -- --config .template-init.json
npm ci
npx playwright install chromium
npm run readiness
npm run check
```

1回目は `initialized`、2回目は `idempotent` を返します。レビュー済みのテンプレート値が先に編集されていた場合や、異なる入力で再初期化しようとした場合は、既存値を上書きせず失敗します。

初期化の詳細と外部サービスの順序は [activation runbook](docs/activation.md) を参照してください。Cursor Cloud を使う場合は、先に [Cursor Cloud onboarding](docs/onboarding-cursor-cloud.md) の Build・model・権限 probe を順番どおり実施します。

## 作業PCをMacへ移す

Macへの移行は、既存PCのフォルダや認証情報を丸ごとコピーせず、fresh cloneから再構築します。Apple Silicon/Intelの前提、Node/npm/Docker、アカウント境界、秘密値の再入力、復旧方法と完了ゲートは [macOS workstation onboarding](docs/onboarding-macos.md) を参照してください。

依存関係を導入した後、秘密値を表示しない自動診断を実行できます。

```bash
npm run workstation:doctor
npm run workstation:doctor -- --require-env --require-docker
```

通常診断では `.env.local` と Docker を optional として扱い、後者の厳格モードではMac移行完了に必要な項目としてfail closedで検査します。

## ローカル準備、Cursor Build、ライブ準備

`npm run readiness` は次を別々に表示します。

- `local.status: ready`: package slug、所有者設定、URL、ローカルポートが整合し、ローカル実装を開始できる。
- `liveProviders.*.status: needs-codex`: この provider-free readiness コマンドでは、対象の個人アカウントや hosted project がまだ確定していない。

`npm run cursor:doctor -- --build` は、committed environment、Node/npm、Docker executable、Chromium executable を検査します。`Status: ready` は Build readiness であり、Cursor の connector、実 model、provider identity、または write authority の有効化を意味しません。

ローカル準備完了は、デプロイやドメイン公開の成功を意味しません。未有効化の clean-room template は provider activation を `needs-cursor-or-codex` として扱います。外部操作は、個人 connector identity・対象・Issue allowlist・redacted result・post-state を確認した Codex、または live activation 済み Cursor Cloud だけが行えます。Claude local は authenticated provider の read/write と shell/network/MCP を引き続き禁止され、外部情報が必要な場合は Codex へ委譲します。

## 環境変数

`.env.example` を `.env.local` にコピーし、対象プロジェクトのブラウザ公開可能な Supabase URL と publishable key を設定します。`NEXT_PUBLIC_` 変数には service-role key やプロバイダートークンを入れないでください。

認証には `APP_ORIGIN` と `AUTH_SIGNUP_MODE` の明示設定が必要です。verified claims、redirect allowlist、招待制と公開登録の境界は [authentication runbook](docs/authentication.md) を参照してください。

## 検証

日常の全検証は次です。

```powershell
npm run check
npm run test:e2e
```

`npm run check` は初期化マニフェスト、所有者ポリシー、Markdown link、受け入れ条件トレース、生成 wrapper、デプロイ/DNS policy、lint、型、unit、Server-only 違反の実ビルド拒否、ブラウザ bundle の秘密情報 scan、production build を検証します。

Supabase の migration、RLS、grant、生成型、実 JWT は Docker を使う別検証です。

```powershell
npm run db:verify
npm run auth:verify
npm run db:stop
```

Docker daemon に接続できない場合は `NOT RUN` と exit code 2 を返し、成功として扱いません。最終完了監査は全項目を個別ステータスで保存します。

```powershell
npm run audit:completion -- --include-integration --require-all
```

クリーンルームで別名アプリを生成し、依存関係の固定インストール、`npm run check`、readiness、desktop/mobile smoke まで実行する検証は `npm run template:verify` です。

Cursor の repository/Build 準備だけを確認する場合は `npm run cursor:doctor -- --build`、live activation の redacted evidence を検査する場合は `npm run cursor:doctor -- --activation-input .artifacts/cursor/<file>.json` を使います。後者は現在の `cursor/<issue>-<slug>` branch、configured reviewer model、public ownership identifiers と一致しなければ fail closed です。

## リポジトリの正本

- [AGENTS.md](AGENTS.md): 全モデル共通の実行規約
- [specs/README.md](specs/README.md): 仕様の正本と更新ルール
- [completion audit trace](specs/completion-audit.md): Issue #1–#8・#19 と現在の実装/検証の対応
- [authority boundary](docs/authority.md): アカウントと外部操作の権限境界
- [workflow](docs/workflow.md): Issue から squash merge までの標準手順
- [security](docs/security.md): 秘密情報と Claude 実行ガード
- [verification](docs/verification.md): 必須検証と証跡
- [macOS onboarding](docs/onboarding-macos.md): fresh cloneによる作業PC移行と完了ゲート
- [Cursor Cloud onboarding](docs/onboarding-cursor-cloud.md): Build、model/capability probe、connector activation、first PR、revocation

この golden repository の実装履歴は [GitHub Issues](https://github.com/yuto1201/Web-Template/issues) にあります。生成後はリンクが生成先 owner/repository に置き換わり、そのリポジトリの Issue が作業の正本になります。
