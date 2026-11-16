# GitHub Pages と Cloudflare の公開手順

公開先は `https://limxiao.github.io/nlp/` です。GitHub の `limxiao` アカウントと、D1を作成できる Cloudflareアカウントで以下を実行します。Cloudflare Workers Free と、公開リポジトリ向けの GitHub Pages を使います。

## 1. ソースと非公開データを準備する

`nlp-source.zip` と `nlp-private-content.zip` を別々のフォルダーへ展開します。ここではソースのフォルダーを作業ディレクトリとし、非公開マニフェストと生成するSQLは同期・公開の対象外の隣接フォルダーに置きます。

```sh
npm install -g pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

Python 3.9 以上で、非公開フォルダーを指定して SQL を生成します。既存の出力ファイルは上書きしません。

```sh
python3 scripts/import_content.py \
  ../private-content/toc-symbols.json \
  ../private-content/body.json \
  ../private-content/chapter1-analysis.json \
  --output ../private-content/initial.sql
```

出力は `161 sections, 8 assets, 0 historical revisions` です。式、表、脚注は本文のMarkdown/LaTeXに含まれます。取り込みをローカルの使い捨てD1とChromiumで先に確認できます。

```sh
pnpm exec playwright install chromium
export NLP_PRIVATE_SQL="$(cd ../private-content && pwd)/initial.sql"
./scripts/check-local
```

## 2. GitHub OAuth App を登録する

`limxiao` で GitHub の **Settings → Developer settings → OAuth Apps → New OAuth App** を開きます。

| 項目 | 値 |
| --- | --- |
| Application name | 自然言語処理の基礎 |
| Homepage URL | `https://limxiao.github.io/nlp/` |
| Authorization callback URL | `https://limxiao.github.io/nlp/` |
| Device Flow | 無効 |

登録後に Client ID を控え、**Generate a new client secret** を実行します。Client secret は手順3で Wrangler の入力プロンプトへ貼ります。[GitHub OAuth App の登録](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)

## 3. D1 と Workers を作る

```sh
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler d1 create nlp
```

表示されたD1のIDを `wrangler.toml` の `[[env.production.d1_databases]]` の `database_id` に設定します。データベース名を変えた場合はコマンドの `nlp` と同じ名前を指定します。`[env.production.vars]` の `GITHUB_CLIENT_ID` に手順2で確認した Client ID を記入し、`SITE_ORIGIN` は `https://limxiao.github.io` にします。Workers名 `nlp-textbook` が既存アプリに使われている場合はこの専用アプリ用に名前を選んでください。アカウント初回は Cloudflare ダッシュボードの Workers & Pages で `workers.dev` サブドメインを登録します。

新しいD1にマイグレーションを適用し、ローカルで確認した非公開SQLを読み込みます。

```sh
pnpm exec wrangler d1 migrations apply nlp --remote --env production
pnpm exec wrangler d1 execute nlp --remote --env production --file ../private-content/initial.sql
pnpm exec wrangler d1 execute nlp --remote --env production \
  --command 'SELECT (SELECT count(*) FROM sections) AS sections, (SELECT count(*) FROM assets) AS assets;'
pnpm exec wrangler deploy --env production
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --env production
openssl rand -hex 32 | pnpm exec wrangler secret put AUTH_KEY --env production
```

表の件数は161と8です。非公開SQLの初期取り込みは空のコンテンツ用です。途中で失敗した場合は、表示されたエラーと件数を確認し、初期化専用の新しいD1に対して再試行してください。公開中のDBから復旧する場合は手順6を使います。

Worker の出力に表示された HTTPS の `workers.dev` URL を控えます。環境名により実際のサービス名が変わるため、出力を使用してください。secrets は本番 Worker に登録し、GitHub の変数には接続先のURLのみを入れます。[D1 マイグレーション](https://developers.cloudflare.com/d1/reference/migrations/) [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## 4. 専用リポジトリから Pages を公開する

1. GitHub で所有者 `limxiao`、リポジトリ名 `nlp` の公開リポジトリを作成します。リポジトリが既にある場合は、履歴を取得して既存のコードと統合します。
2. **Settings → Secrets and variables → Actions → Variables** で、リポジトリ変数 `PUBLIC_API_ORIGIN` に手順3のHTTPSオリジンを登録します。末尾のスラッシュや `/v1` は付けません。
3. **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にします。
4. 空の専用リポジトリにソース一式をコミットし、`main` へ push します。コミット前に `git status --short` で公開対象を確認してください。

```sh
git init -b main
git add .github .env.example .gitignore *.md *.json *.mjs *.toml *.yaml *.ts src worker scripts tests
git status --short
git commit -m "Add authenticated NLP textbook"
git remote add origin https://github.com/limxiao/nlp.git
git push -u origin main
```

Actions の **GitHub Pages** ワークフローが完了し、デプロイ先が `https://limxiao.github.io/nlp/` であることを確認します。既存のユーザーサイトリポジトリのコミットや設定操作は不要です。[GitHub Pages の公開ソース](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## 5. HTTPS 公開後の確認

1. プライベートウィンドウで `https://limxiao.github.io/nlp/#s-2-5-1/eq-2.12` を開き、ログイン画面を確認します。
2. Worker URL に `/v1/toc`、`/v1/search?q=test`、`/v1/sections/s-2-5-1`、`/v1/assets/fig-2-2` を加えて、未認証で HTTP 401 と `Cache-Control: no-store` が返ることを確認します。
3. Pages の GitHub ログインから `limxiao` でログインします。管理者専用の操作が表示されることを確認し、共通パスワードを生成または入力して保存します。
4. 別のブラウザで共通パスワードを使い、直接リンクの式、目次、記号表、図版、検索を確認します。管理者側で一時的な検証用の節を作り、別ブラウザで再読み込みし、新規節を確認します。検証後は管理画面で削除します。
5. パスワードを変更して旧パスワードと先ほどの閲覧セッションが拒否されること、新パスワードで本文が読めること、管理者が継続して操作できることを確認します。

Cloudflare の Free 枠では Workers の上限は10 ms CPU／呼び出し、100,000リクエスト／日です。D1は1DBあたり500 MB、1行あたり2 MB、1呼び出しあたり50問い合わせ、アカウントあたり1日500万行の読み取りと10万行の書き込みが上限です。ローカル計測は本番のCPU上限を再現しないため、公開直後に実際の Free Worker でログイン、パスワード更新、最大に近い画像取得・登録、検索を実行し、ダッシュボードの CPU Time と `Exceeded CPU Time` 件数を確認します。書籍全体の取り込み後は D1 のクエリ統計と日次行消費量も確認してください。[Workers の上限](https://developers.cloudflare.com/workers/platform/limits/) [D1 の上限](https://developers.cloudflare.com/d1/platform/limits/) [D1 の Free 枠](https://developers.cloudflare.com/d1/platform/pricing/)

## 6. バックアップの復元

管理画面からダウンロードした `*.backup.json` を非公開フォルダーに置き、復元SQLを生成します。

```sh
python3 scripts/import_content.py --backup ../private-content/nlp.backup.json \
  --output ../private-content/restore.sql
```

別名で新しいD1を作成してマイグレーションを適用します。復元SQLをそのDBに読み込み、章節件数、画像、履歴を確認してください。本番環境の `database_id` と `database_name` を新DBへ差し替え、Workerをデプロイします。GitHubで再ログインし、閲覧パスワードを設定します。セッション・試行回数カウンターも新DBで初期化されます。切り替え直前のデータは旧DBで保持し、受け入れ確認後に管理してください。
