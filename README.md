# 自然言語処理の基礎

GitHub Pages の `/nlp/` で使う会員制のオンライン教科書です。Astro で画面を配信し、Cloudflare Workers が認証・認可を行い、D1 から目次・本文・画像を返します。管理者は GitHub でログインし、ブラウザの CodeMirror で Markdown と LaTeX を編集できます。

## このリポジトリの構成

| パス | 内容 |
| --- | --- |
| `src/` | ログイン、閲覧、検索、編集、KaTeX 描画 |
| `worker/src/` | 認証、コンテンツ API、画像配信 |
| `worker/migrations/` | D1 のスキーマ、履歴・全文検索の更新トリガー |
| `scripts/import_content.py` | 非公開の章節マニフェストやバックアップから D1 取り込み SQL を生成 |
| `tests/` | ローカル Workers・D1 の API テストと Chromium E2E |
| `.github/workflows/pages.yml` | 専用リポジトリからの GitHub Pages 公開 |

本文・図版は、別添の非公開データ一式にあります。原本、作業中の OCR、取り込みデータ、D1 のローカル状態、バックアップを公開リポジトリや `dist/` の外に保管してください。

## ローカル検証

Node.js 24、pnpm 11.25.0、Python 3.9 以上を使用します。E2E は Chromium を使います。

```sh
npm install -g pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
./scripts/check-local
```

Chromium 互換の Chrome がインストール済みの場合は、`PLAYWRIGHT_CHROME` に実行ファイルのパスを指定できます。ブラウザテストは `127.0.0.1:4321` と `127.0.0.1:8787` を一時的に使います。API テストと E2E は使い捨ての D1 を作り、GitHub が返す認可コード・プロフィールだけをテスト用に差し替えます。

原典の取り込み手順と `NLP_PRIVATE_SQL` で実データを含めたテストを実行する手順は [DEPLOYMENT.md](DEPLOYMENT.md) にあります。

## ローカルで手動操作する

ローカル用の GitHub OAuth App を登録し、コールバックに `http://127.0.0.1:4321/nlp/` を指定します。無視設定済みの `.dev.vars` に `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`AUTH_KEY` を設定します。`AUTH_KEY` には `openssl rand -hex 32` で生成した値を使います。

```sh
pnpm db:local
pnpm exec wrangler d1 execute nlp --local --file ../private-content/initial.sql
```

初期SQLの作り方は [DEPLOYMENT.md](DEPLOYMENT.md) の手順1にあります。別々の端末で `pnpm api:dev` と `pnpm dev` を実行して、`http://127.0.0.1:4321/nlp/` を開きます。GitHub の管理者ログイン後に共通パスワードを設定できます。

## 資料

- [アーキテクチャと API](ARCHITECTURE.md)
- [認証と秘密情報](SECURITY.md)
- [公開手順](DEPLOYMENT.md)
- [管理画面](ADMIN_GUIDE.md)
- [取り込み・校正記録](TRANSCRIPTION_REPORT.md)
- [検証状況と引き継ぎ](HANDOVER.md)
