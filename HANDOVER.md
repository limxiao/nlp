# 引き継ぎ

## 現在の状態

静的フロントエンド、Workers API、D1マイグレーション、GitHub Pages ワークフロー、管理・バックアップ機能、非公開の初期コンテンツを用意した。GitHub公開APIの確認では、`limxiao/nlp` と `https://limxiao.github.io/nlp/` はHTTP 404だった。検証環境には本番Cloudflareの認証とGitHubの書き込み用認証がなかったため、公開操作は所有者のアカウント設定待ち。既存の個人サイトの作業コピーは保持した。

公開に必要な値は、OAuth App の Client ID・Client secret、D1のID、Workersの `AUTH_KEY`、Pagesリポジトリの `PUBLIC_API_ORIGIN`。設定順序は [DEPLOYMENT.md](DEPLOYMENT.md) に記載した。本番OAuthの疎通、本番のFree CPU計測、別ブラウザでの本番確認は公開後に行う。

## 追加収録と保守

- 既存章節の本文はブラウザの編集画面で入力する。新規項目をまとめて追加する場合は、同じ形式の非公開JSONを作成し、取り込みスクリプトでSQLを生成する。既に登録された親に追加する際は、親IDと種類を `--existing-parent ch-3:chapter` の形式で指定できる。SQLの取り込みは新しいIDを追加する用途に使い、既存の版は管理APIから更新する。
- スキャン PDF はページ単位でローカルOCRし、原本画像で本文・LaTeX・数式番号・脚注・図表を照合してから取り込む。出典のページ番号を、印刷ページ番号と別に記録する。読めない箇所は校正待ちにする。
- データ構造、認証制約、API一覧は [ARCHITECTURE.md](ARCHITECTURE.md) と [SECURITY.md](SECURITY.md) を参照。D1の変更は番号付きマイグレーションを追加して適用する。
- バックアップは管理画面から非公開の保管先へ取得する。復旧では別のD1に復元して検証し、同じアプリに切り替える。定期的な取得と復元確認は運用時に行う。

## 検証の再実行

`pnpm check` でブラウザ・Workersの型を確認する。`pnpm test` でローカル Workers と D1 に対する認証、権限、競合、復元、画像、検索を確認する。`./scripts/check-local` は静的ビルドと Chromium E2E も実行する。`NLP_PRIVATE_SQL` を指定すると原本データを使った閲覧テストも走る。テスト用の GitHub 応答はローカルだけで使う。

`pnpm exec wrangler deploy --dry-run --env production` はバンドルと設定の検証に使える。本番への反映は [DEPLOYMENT.md](DEPLOYMENT.md) の設定と操作を行った時点で確認する。

## 今回確認した結果

- Astro の静的ビルド、TypeScript の型検査、Wrangler の本番設定での dry-run が成功した。
- ローカル Workers・D1 の Node API テストは7件、ChromiumのE2Eは3件成功した。モバイル幅での直接リンク、未認証・権限制御、数式と図版、編集保存と別ブラウザでの確認、履歴復元、パスワード更新、新しい節、バックアップの取得と復元SQLの適用を確認した。
- 原本データを入れた使い捨てD1で、閲覧者として目次161件と、本文・記号表20件の数式317件、図版8点を確認した。
- 依存関係を Astro 7.4.12 と KaTeX 0.19.1 に更新し、納品時の `pnpm audit` は指摘0件だった。
