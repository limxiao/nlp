# 認証と秘密情報

## 閲覧者

管理画面で生成したパスワードには暗号学的乱数32バイトを使います。手動指定では16文字以上が必要です。Workers は毎回異なるランダムソルトと Workers secret の256ビット鍵で HMAC-SHA-256 の検証子を計算し、D1 にソルトと検証子だけを保存します。Workers の `timingSafeEqual` で固定長の検証子を比較します。鍵とD1の両方が漏れる場合に備え、高エントロピーの生成パスワードを使ってください。高コストの反復KDFの運用は Free の CPU 制限下で計測が必要になるため、ここでは鍵付き検証とオンラインのレート制限を選択しています。

閲覧ログインを15分枠あたりIP別10回かつ全体160回に制限します。IPはCloudflareの `CF-Connecting-IP` を鍵付きハッシュ化してカウンターに使用します。全体の上限に達した場合は正規のログインも次の枠まで待ちます。認証済みの閲覧継続には影響しません。

D1 のパスワード世代が変わると旧世代の閲覧セッションは次の認証付き取得から拒否されます。変更と競合した旧世代セッションの発行はSQL条件で拒否します。受信済みの本文はブラウザの表示や利用者が保存したコピーに残り得ます。

## 管理者

許可する GitHub 数値IDは `212172861` です。GitHub の公開ユーザー API で `limxiao` に対応する値を確認し、Workers の `auth.ts` に固定しました。ブラウザが生成したPKCE検証子と Workers が発行した state を組み合わせます。stateはD1にハッシュ化して保存し、有効期間は10分で、正しいPKCE検証子と共に提示された場合だけ一度使えます。

OAuth のコールバックは Pages の `/nlp/` です。ブラウザは認可コードと state を履歴のURLから取り除き、Workers に POST します。秘密鍵を使ったコード交換と GitHub のユーザー API 呼び出しは Workers 内で完結します。GitHub のアクセストークンは当該リクエスト内でのみ使います。アプリ独自の管理者セッションの期限は30分、閲覧者セッションは60分です。照合済みトークンのハッシュをD1に記録します。共通パスワードを更新しても管理者セッションは有効です。

## ブラウザと通信

- CORS は設定した単一オリジンです。Bearerトークンを `sessionStorage` に置き、URLとCookieを使わずにAPIへ渡します。本番は HTTPS を要求します。
- API に `Cache-Control: no-store, private`、`nosniff`、`Referrer-Policy: no-referrer` を付与します。認証は、目次・画像・本文・検索・記号表を含む各取得で照合します。
- Markdown の生HTMLは無効です。URLは内部アンカー、`https:`、登録した図版IDに制限します。画像の外部 URL は読み込みません。KaTeX は `trust: false` とマクロ展開上限を使用します。
- 静的HTMLの CSP では外部スクリプトと外部画像を許可せず、接続先を固定します。GitHub Pagesの `limxiao.github.io` で配信する他のパスとは、ブラウザのオリジン境界を共有します。個人サイト側のスクリプトと公開権限も管理対象です。
- Worker は認証値、検索語、本文、Authorization ヘッダーをログ出力しません。本番のアプリケーションログは Wrangler 設定で無効にしています。調査時も要求本文・ヘッダーをログへ追加しないでください。

Cloudflare の Free 上限と公開後のCPU確認手順は [DEPLOYMENT.md](DEPLOYMENT.md) に記載しています。GitHub のOAuthフローと鍵の登録方法は公式資料を参照してください。[GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) [Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
