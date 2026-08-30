# Template activation runbook

初期化と外部サービスの有効化は別工程です。`template:init` が成功しても、Supabase・Vercel・Cloudflare が作成済み、接続済み、公開済みという意味にはなりません。

## 1. GitHub Template から生成する

1. GitHub の **Use this template** から新しいリポジトリを作成する。
2. `npm ci` で canonical authority parser を含む依存関係を取得する。
3. `template-init.example.json` を `.template-init.json` にコピーする。
4. アプリ名、slug、GitHub owner/repository、衝突しないローカルポート、予定する HTTPS ホスト名と Cloudflare zone を設定する。
5. `npm run template:init -- --config .template-init.json` を実行する。
6. 同じコマンドをもう一度実行し、`idempotent` を確認する。
7. `npm run readiness`、`npm run check` を実行する。

初期化ツールは `config/template.json` に記録されたレビュー済み出現箇所だけを書き換えます。対象値が先に編集されていた場合は、部分的に上書きせず失敗します。異なる設定での再初期化も拒否します。

生成後に baseline の migration、Auth、deployment、domain 機能を変更または削除する場合は、`config/acceptance.json` の証拠パスと検証コマンドも同じ Issue で更新します。古い完了証拠を残したまま機能だけを外す変更は `npm run audit:trace` が拒否します。

## 2. ローカル準備完了を確認する

`npm run readiness` の `local.status` が `ready` なら、アプリ名、package slug、所有者設定、公開ホスト名、ローカルポートの整合が取れています。プロバイダーごとの `needs-codex` はライブ有効化が未完了という既存の機械可読 status 名であり、operator authority を Codex に限定する意味ではありません。

`.env.example` を `.env.local` へコピーし、ブラウザ公開可能な Supabase URL と publishable key だけを設定します。service-role key やプロバイダートークンを `NEXT_PUBLIC_*` に設定してはいけません。

## 3. Account-bound operator がライブ接続を有効化する

Claude と Codex は implementer / external-operator として同じ account-bound authority を持ちます。外部操作は [authority boundary](authority.md) に従い、protected `main` authority、Issue の宣言目的、service mode、exact target、fresh receipt が一致した operator だけが行います。operator label は認証情報ではなく、自動 account switch は禁止です。

1. `config/ownership.json` の GitHub owner/repository が生成先と一致することを確認する。
2. 個人 Supabase organization を確認し、プロジェクト作成または既存 project ref の採用を事前報告する。
3. migration、RLS、grant、Auth redirect をローカルで検証してから、remote schema を expand → deploy → contract の順で適用する。
4. 個人 Vercel scope/project を確認し、Development・Preview・Production の環境変数名を検証してから Preview を作成する。
5. Preview の smoke と production preflight が通った後だけ Production を更新する。
6. Vercel にドメインを登録し、提示された最新の A/CNAME を読み取る。
7. 個人 Cloudflare account/zone を確認し、対象1件だけを DNS-only で適用する。
8. DNS、TLS、`/`、`/health` を確認してライブ準備完了を記録する。

GitHub・Supabase・Vercel・Cloudflare は `repository-active` ですが、Issue scope を超えて使えるという意味ではありません。Linear は `explicit-user-purpose-only` で、現在は操作自体が未登録のため、目的や stable IDs が揃っても read/write とも fail closed です。高リスク write は production provider client が実装済みの場合に限り、exact-Head gate を再実行し、preflight → one-time claim → result/finalize の順に redacted receipt を残します。このリリースで production client があるのは GitHub Issue read と exact-Head squash merge だけです。

provider ID は資格情報ではありませんが、別アカウントへの誤操作を防ぐ所有境界です。トークン、cookie、secret、service-role key、個人メール生値は設定ファイル、Issue、PR、スクリーンショット、監査成果物へ保存しません。テンプレート生成では account/target を明示入力するか inactive placeholder を使い、source identity の残留と異なる authority fingerprint での再初期化を拒否します。

## 4. 完了監査

通常の検査は `npm run check` です。ブラウザ、ローカル Postgres、実 JWT を含む最終監査は次で実行します。

```powershell
npm run audit:completion -- --include-integration --require-all
```

Docker daemon が利用できない場合、DB/Auth は `not-run` となり、`--require-all` では成功扱いになりません。結果は秘密を含まないステータスだけを `.artifacts/completion-audit.json` に保存します。
