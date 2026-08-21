# Completion audit trace

`config/acceptance.json` が機械可読な正本です。この文書は Issue #1–#8 の受け入れ条件が、現在の実装とどの検証に接続されるかを人が読める形で示します。

| Issue | 現在の責務 | 主な実装証拠 | 実行証拠 |
|---|---|---|---|
| #1 | リポジトリ規約、個人アカウント境界、秘密情報拒否 | `AGENTS.md`, `docs/authority.md`, `tools/repository-policy.mjs` | `npm run policy` |
| #2 | Next.js、strict TypeScript、公開/サーバー環境境界 | `src/app/`, `src/lib/env/`, bundle scanners | `typecheck`, unit, boundary, client scan, build |
| #3 | migration、RLS、grant、生成型 | `supabase/migrations/`, pgTAP, DB verifier | `npm run db:verify` |
| #4 | 実 JWT、SSR cookie、refresh、保護ルート | Auth/Supabase server clients、proxy、integration verifier | `npm run auth:verify` |
| #5 | Issue 状態機械、反対モデル評価、Claude 外部ツール拒否 | workflow core、agent wrappers、PreToolUse guard | wrapper drift、unit/workflow suites |
| #6 | Vercel link、環境変数分類、Preview/Production release evidence | deployment config/core/tests | deployment lint、browser smoke |
| #7 | Vercel 提示値からの Cloudflare DNS-only 差分、rollback、TLS | domain config/core/tests/runbook | domain lint、plan-bound release verification |
| #8 | 一度だけの安全な初期化、clean-room、リンク、完了監査 | template config/core/tests、activation runbook | source check、clean-room verify、completion audit |

ライブ成功はコードだけから推測しません。Vercel、Cloudflare、TLS、HTTP のライブ証拠は対象 PR に記録し、生成後の各アプリでは同じ provider preflight をやり直します。Supabase hosted project が未作成なら `readiness` はローカル準備完了とライブ未準備を分けて表示します。
