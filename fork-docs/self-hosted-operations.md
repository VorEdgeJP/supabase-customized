# セルフホスト運用ガイド

- 対象: `docker/` の docker-compose によるセルフホスト構成
- 関連: `fork-docs/service-health-design.md`、`fork-docs/self-hosted-metrics-design.md`、`fork-docs/self-hosted-backups-design.md`

## 1. このドキュメントの位置づけ

設計書は機能ごとの実装方針を記録したものです。本書はその先の運用面、つまり「どのサービスが必要で、どれを止められるか」と「実機で踏んだ落とし穴」をまとめます。

デプロイ固有の値 (ホスト名、バケット名、資格情報、サーバーのアドレス) は本書には書きません。それらは `.env` と各デプロイ先の設定に置いてください。本リポジトリは公開されています。

## 2. サービスの依存関係

`depends_on` による起動順の依存と、環境変数やゲートウェイのルーティングによる実行時の依存を合わせたものです。

| サービス                  | 役割                                                                                                                                | 依存先                              | 依存元                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------- |
| `db`                      | Postgres 本体。`postgres` DB のほか内部用の `_supabase` DB を持ちます                                                               | なし                                | ほぼ全サービス                    |
| `supavisor`               | 接続プーラー。session と transaction の 2 ポートを公開します。テナント情報は `_supabase` に保存します                               | `db`                                | 外部アプリ                        |
| `studio`                  | ダッシュボード                                                                                                                      | `meta`、ゲートウェイ、(`analytics`) | ゲートウェイが healthy を待ちます |
| `meta`                    | Postgres のイントロスペクションと DDL 実行 API                                                                                      | `db`                                | `studio`                          |
| `api-gw` (Envoy) / `kong` | API ゲートウェイ。`/rest/v1` `/auth/v1` `/storage/v1` `/realtime/v1` `/functions/v1` `/graphql/v1` を振り分け、API キーを検証します | `studio`                            | `functions`、`studio`、外部アプリ |
| `rest` (PostgREST)        | テーブルの REST API 化。GraphQL も `rpc/graphql` 経由でここを通ります                                                               | `db`                                | `storage`、ゲートウェイ           |
| `auth` (GoTrue)           | ユーザー認証と JWT 発行                                                                                                             | `db`                                | ゲートウェイ                      |
| `storage`                 | ファイルストレージ。メタデータ操作は PostgREST 経由です                                                                             | `db`、`rest`、`imgproxy`            | ゲートウェイ、`studio`            |
| `imgproxy`                | 画像変換                                                                                                                            | なし                                | `storage` のみ                    |
| `functions`               | Deno のエッジ関数ランタイム                                                                                                         | ゲートウェイ                        | ゲートウェイ                      |
| `realtime`                | WebSocket による DB 変更配信と presence                                                                                             | `db`                                | ゲートウェイのみ                  |
| `analytics` (Logflare)    | ログの集約と検索 API。`_supabase` の `_analytics` スキーマに保存します                                                              | `db`                                | `studio` の Logs 画面             |
| `vector`                  | Docker socket から全コンテナのログを読み、Logflare に送ります                                                                       | なし                                | `analytics`                       |

`analytics` と `vector` は `docker-compose.logs.yml`、Prometheus 一式は `docker-compose.metrics.yml` の override に含まれます。

## 3. 用途別の最小構成

### すべての機能を使う場合

上記のすべてが必要です。

### プーラー直結と Storage だけを使う場合

アプリケーションが Supavisor 経由で Postgres に直接つなぎ、ファイル配信に Storage を使うだけの構成では、次が必要です。

- `db` / `supavisor` — アプリケーションが直接使用します
- `storage` — 使用します
- `rest` — `storage` が `POSTGREST_URL` と `depends_on` の両方で参照するため、外部に公開しなくても稼働させます
- `imgproxy` — Storage の画像変換 (`/render/image/...`) を使う場合に必要です。使わないなら `ENABLE_IMAGE_TRANSFORMATION` を無効にしたうえで停止できます
- ゲートウェイ — Studio の Storage 画面が `SUPABASE_URL` 経由でゲートウェイを通るため必要です
- `meta` — Studio のテーブルエディタと SQL エディタの実体です
- `studio` — 使用します

停止できるのは `auth`、`functions`、`realtime` です。Logs 画面を使わないなら `analytics` と `vector` も止められます。この 2 つは Vector が全コンテナのログを読み続け、Logflare が常駐したうえで書き込みが DB に蓄積されるため、負荷軽減の効果が最も大きい組み合わせです。停止する場合は Studio の `ENABLED_FEATURES_LOGS_ALL` を `false` に戻してください。

Requests グラフを Logflare ではなく Prometheus から取る設定 (`METRICS_REQUESTS_SOURCE=prometheus`) にしていれば、`analytics` を止めてもホームのグラフは残ります。

## 4. サービスの止め方

`docker compose stop` だけでは次の `docker compose up -d` で復活します。compose 側で無効化してください。サービスブロックをコメントアウトするより、`profiles` を 1 行足す方が差分が小さく元に戻しやすくなります。

<!-- prettier-ignore -->
```yaml
  auth:
    container_name: supabase-auth
    profiles: ["disabled"]
```

あわせて、サービスヘルスカードが UNHEALTHY ではなく DISABLED を表示するよう、`studio` の環境変数で該当サービスの URL に空文字を渡します。

<!-- prettier-ignore -->
```yaml
      SERVICE_HEALTH_AUTH_URL: ""
      SERVICE_HEALTH_FUNCTIONS_URL: ""
```

適用は次のとおりです。停止済みのコンテナは `up -d` では消えないため、先に削除します。

```bash
docker compose config > /dev/null
docker compose stop auth functions
docker compose rm -f auth functions
docker compose up -d
docker compose restart nginx   # リバースプロキシを使っている場合 (§5 参照)
```

ゲートウェイの設定に残った該当ルートは、呼ばれれば 502 を返すだけで害はありません。外部からの到達を断ちたい場合は、リバースプロキシ側で該当の location を削除すると、ゲートウェイに届く前に 404 になります。

## 5. 実機で踏んだ落とし穴

**PostgREST の admin サーバーには特殊ホスト名を使えません。** compose の healthcheck は `postgrest --ready` を実行しますが、これは `server-host` が Warp の特殊ホスト名 (`*4`、`*6` など) だと「実際のアドレスが分からない」として失敗します。Studio から `/ready` に到達させるために全インターフェースへ bind する場合は、`*4` ではなくリテラルの `0.0.0.0` を指定してください。特殊ホスト名のままだとコンテナは正常に動作しているのに常時 unhealthy と表示されます。

**リバースプロキシは upstream の IP をキャッシュします。** nginx を前段に置いている場合、`proxy_pass http://studio:3000` のようなホスト名は起動時に一度だけ解決されます。`studio` コンテナを再作成すると IP が変わり、502 が出ます。コンテナを再作成した後は必ずプロキシを restart してください。

**Logflare の `usage.api-counts` は Postgres バックエンドでは動きません。** ホームの Requests グラフが参照するこの named endpoint は、Postgres バックエンド構成の Logflare では HTTP 200 で `{"error":{"code":502}}` を返します。セルフホストで Requests グラフを出す場合は Prometheus 側 (`METRICS_REQUESTS_SOURCE=prometheus`) を使ってください。

**Kong の prometheus プラグインは同梱されていますが既定では無効です。** イメージにはプラグイン本体が含まれているため、`KONG_PLUGINS` への追加と宣言設定への `plugins: - name: prometheus` の記述、`KONG_STATUS_LISTEN` の設定で有効になります。ビルドし直す必要はありません。

**セルフホストの Studio には認証機能がありません。** `withAuth` は `IS_PLATFORM` が false のとき素通しになります。ダッシュボードを守っているのはゲートウェイの basic auth (`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`) か、その前段のリバースプロキシです。Studio のポートを直接公開する構成にする場合は、プロキシ側で確実に認証を掛けてください。GoTrue (`auth`) はダッシュボードのログインには一切関与しないため、`auth` を停止してもログインには影響しません。

**Studio の Storage 画面はゲートウェイを経由します。** `pages/api/platform/storage/[ref]/**` は `SUPABASE_URL` を向いた supabase-js クライアントを使うため、Studio → ゲートウェイ → `storage` という経路になります。リバースプロキシが `/storage/v1` をゲートウェイを通さず `storage` に直接転送している構成でも、Studio 内部の経路は変わりません。

**cron スクリプトの時刻判定は起動時刻と揃えてください。** cron はサーバーのローカル時刻で起動します。スクリプト側が `date -u` で「特定の時刻の回だけ日次コピーを作る」といった判定をしていると、タイムゾーンの差で一度も条件が成立しない場合があります。判定と起動を同じ基準に揃えてください。タイムスタンプ自体を UTC で持つこととは別の話です。

## 6. バックアップ運用の推奨形

Studio の Backups 画面は、オブジェクトストレージ上の世代を次の形で並べることを前提にしています (`fork-docs/self-hosted-backups-design.md` §4.3)。

```
<prefix>/6h/YYYY/MM/DD/<STAMP>/     短間隔の世代
<prefix>/daily/<STAMP>/             日次
<prefix>/monthly/<STAMP>/           月次
```

`STAMP` は `YYYYMMDDTHHMMSSZ` (UTC) です。短間隔の世代を保持期間の短いルールで失効させ、日次と月次を長期側のルールに載せる階層保持を、オブジェクトストレージのライフサイクルルールで組むと運用が単純になります。この構成ではプレフィックスごとにルールを分ける必要があります。バケット全体に単一のルールを掛けると、日次と月次も短間隔の世代と同じ期間で消えてしまいます。

Studio 側は世代ディレクトリの中身から状態を判定します。マニフェスト、ロール定義、設定アーカイブ、1 つ以上のダンプが揃っていれば `COMPLETED`、欠けていれば `INCOMPLETE` と表示します。
