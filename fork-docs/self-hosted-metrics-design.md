# セルフホスト向けメトリクス表示 (コンピュート使用率・リクエストグラフ) 設計書

- 対象: `apps/studio` および `docker/` (VorEdgeJP/supabase-customized フォーク)
- ステータス: 設計 (実装と同時進行)
- 作成日: 2026-09-03
- 前提: `fork-docs/service-health-design.md` (サービスヘルス) の方針を踏襲します

## 1. 背景と目的

Supabase Cloud のプロジェクトホームには、サービスヘルスの他に次の表示があります。

1. **Compute カード** (`ActivityStats.tsx`): インスタンスサイズとリソース警告
2. **Requests グラフ** (`ProjectUsageSection.tsx`): Database / Auth / Storage / Realtime のリクエスト数推移
3. **Observability > Database** の CPU / メモリ / ディスク IO / 接続数チャート

セルフホスト (docker-compose) では次の理由でいずれも表示されません。

- `Home.tsx` で `usage` セクションが `IS_PLATFORM` に固定されている
- `pages/api/platform/projects/[ref]/infra-monitoring.ts` が `{ data: [] }` を返すだけのスタブである
- compose スタックに Prometheus や exporter が無く、CPU / メモリのデータ源そのものが存在しない
- Requests グラフのデータ源 `usage.api-counts` は Logflare (`docker-compose.logs.yml`) 前提で、Logflare が無い環境では取得できない

本機能は **Prometheus を単一のデータ源** として compose に追加し、Studio の `infra-monitoring` と `usage.api-counts` を Prometheus から返すことで、Cloud と同じ UI コンポーネントをそのまま動かします。Logflare の有無には依存しません。

## 2. スコープ

### 含むもの

- `docker/docker-compose.metrics.yml` (override): `prometheus` / `node-exporter` / `postgres-exporter` の追加と、ゲートウェイ (Envoy / Kong) の Prometheus メトリクス露出
- Studio サーバー側: Prometheus クライアント、`infra-monitoring` の実装、`usage.api-counts` の Prometheus 実装
- Studio クライアント側: ホームの Requests グラフ (既存 `ProjectUsageSection`) をセルフホストで表示、ホームに Compute カード (CPU / メモリ / ディスク使用率) を追加
- Observability > Database のチャートがセルフホストで動作すること (infra-monitoring の実装により自動的に有効化)
- ユニットテスト

### 含まないもの (将来の拡張)

- データベースバックアップ (R2) の表示。別設計とします
- `ProjectUsageSectionDeltas` (成功率付きの新ホーム、feature flag `newHomepageUsageDeltas`)。セルフホストでは flag が false で旧 `ProjectUsageSection` が使われるため対象外とします
- Supavisor のクライアント接続数 (`client_connections_*`, `supavisor_connections_active`)、ディスク IO バジェット (`disk_io_budget`, `disk_io_consumption`)。AWS 固有または exporter 未整備のため、空データを返します
- Logflare 側 `service-health` エンドポイントの代替
- Supabase CLI 環境

## 3. 設計方針

1. **upstream 追従を最優先にする。** 新規ロジックは `lib/api/self-hosted/metrics/` 配下の新規ファイルに閉じ込めます。既存ファイルの変更は次の 5 点に限定します。
   - `pages/api/platform/projects/[ref]/infra-monitoring.ts` (セルフホスト専用スタブ。実装に置き換え)
   - `pages/api/platform/projects/[ref]/analytics/endpoints/[name].ts` (セルフホスト専用。`usage.api-counts` かつメトリクス有効時のみ Prometheus に分岐)
   - `pages/api/platform/deployment-mode.ts` と `data/config/deployment-mode-query.ts` (`metrics_enabled` フィールドの追加)
   - `components/interfaces/ProjectHome/Home.tsx` (`usage` セクションのゲート条件に `metricsEnabled` を OR で追加)
   - `components/interfaces/ProjectHome/TopSection.tsx` (Compute カードのマウント)
2. **Cloud と同じ属性名・レスポンス形を返す。** `infra-monitoring` の属性名は `packages/api-types/types/platform.d.ts` の `InfraMonitoringController_getUsageMetrics` の enum に、レスポンスは `data/analytics/infra-monitoring-query.ts` の `InfraMonitoringSingleResponse` / `InfraMonitoringMultiResponse` に合わせます。これにより Observability の既存チャート定義 (`data/reports/database-charts.ts`) を変更せずに済みます。
3. **Prometheus のクエリはサーバー側に閉じる。** ブラウザから Prometheus に直接アクセスさせず、Studio の API ルートが PromQL を組み立てて `query_range` を叩きます。Prometheus のポートはホストに公開しません。
4. **有効化は環境変数 1 つで判定する。** `METRICS_PROMETHEUS_URL` が空なら従来通り (スタブ / Logflare 転送) の挙動を維持します。
5. **既存流儀に従う。** `assertSelfHosted()`、`apiWrapper`、`lib/api/self-hosted/constants.ts` へのデフォルト集約、Next ルートと TanStack Start (`routes/api/**`) の両対応、zod による境界の検証。

## 4. アーキテクチャ

```
Browser
  ├─ useProjectLogStatsQuery()  (既存)      GET /api/platform/projects/default/analytics/endpoints/usage.api-counts?interval=1day
  │     └─ pages/api/.../analytics/endpoints/[name].ts
  │           ├─ name === 'usage.api-counts' && source === 'prometheus' → getUsageApiCounts()   lib/api/self-hosted/metrics/usage-api-counts.ts
  │           └─ それ以外 → retrieveAnalyticsData() (Logflare 転送、既存)
  ├─ useInfraMonitoringAttributesQuery() (既存)  GET /api/platform/projects/default/infra-monitoring?attributes[]=...&startDate&endDate&interval=1m
  │     └─ pages/api/.../infra-monitoring.ts
  │           ├─ metrics 有効 → getInfraMonitoring()   lib/api/self-hosted/metrics/infra-monitoring.ts
  │           └─ 無効 → 従来のスタブ応答
  └─ useDeploymentModeQuery() (既存)  GET /api/platform/deployment-mode → { is_cli_mode, metrics_enabled, usage_api_counts_source }

lib/api/self-hosted/metrics/prometheus.ts
  └─ queryRange(promql, start, end, step)  →  ${METRICS_PROMETHEUS_URL}/api/v1/query_range

docker-compose.metrics.yml
  prometheus ──scrape──▶ node-exporter:9100      (CPU / メモリ / ファイルシステム / ディスク IO / ネットワーク)
             ──scrape──▶ postgres-exporter:9187  (接続数 / DB サイズ / max_connections / WAL サイズ)
             ──scrape──▶ api-gw:9901 /stats/prometheus   (Envoy: クラスタ別リクエスト数・ステータス)
             ──scrape──▶ kong:8100 /metrics             (Kong: サービス別リクエスト数・ステータス)
```

### 4.1 docker-compose.metrics.yml

`docker/docker-compose.logs.yml` と同じ override 方式です。`COMPOSE_FILE` に追加するか `./run.sh config add metrics` で有効化します。

| サービス            | イメージ                                                 | 役割                                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prometheus`        | `prom/prometheus` (バージョン固定)                       | 保持期間 15 日、named volume `prometheus-data`。ポートはホストに公開しない                                                                                                           |
| `node-exporter`     | `prom/node-exporter` (バージョン固定)                    | `--path.rootfs=/host` でホストの `/` を読み取り専用マウント、`pid: host`                                                                                                             |
| `postgres-exporter` | `prometheuscommunity/postgres-exporter` (バージョン固定) | `DATA_SOURCE_NAME=postgresql://supabase_admin:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/postgres?sslmode=disable`。WAL サイズ用にカスタムクエリ (`pg_ls_waldir`) を追加 |
| `studio` (追記)     | -                                                        | `METRICS_PROMETHEUS_URL=http://prometheus:9090`、`METRICS_GATEWAY=envoy`                                                                                                             |
| `api-gw` (追記)     | -                                                        | Envoy admin を compose ネットワークに向けるため `docker/volumes/api/envoy/envoy.yaml` の admin アドレスを `0.0.0.0:9901` に変更 (ホストには公開しない)                               |

Kong を使う場合 (`docker-compose.kong.yml`、および本番の Kong 2.8.1) は次を追加します。

- `KONG_STATUS_LISTEN: 0.0.0.0:8100`
- `KONG_PLUGINS` に `prometheus` を追加し、`kong.yml` の `plugins:` に `- name: prometheus` を追加
- `studio` に `METRICS_GATEWAY=kong`

Prometheus の設定は `docker/volumes/metrics/prometheus.yml` に置きます。scrape job 名は `node` / `postgres` / `gateway` に固定し、Studio 側の PromQL はこの job 名を前提とします。

### 4.2 サーバー側

#### 環境変数 (`lib/api/self-hosted/constants.ts` に追加)

| 変数                           | 既定値                                                                                                            | 説明                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `METRICS_PROMETHEUS_URL`       | (未設定 = 無効)                                                                                                   | Prometheus のベース URL                                                                          |
| `METRICS_GATEWAY`              | `envoy`                                                                                                           | `envoy` または `kong`。Prometheus からリクエスト数を取る際のゲートウェイ種別                     |
| `METRICS_REQUESTS_SOURCE`      | `METRICS_PROMETHEUS_URL` があれば `prometheus`、無ければ `LOGFLARE_URL` があれば `logflare`、どちらも無ければ無効 | ホームの Requests グラフ (`usage.api-counts`) のデータ源。`prometheus` / `logflare` / `disabled` |
| `METRICS_TIMEOUT_MS`           | `5000`                                                                                                            | Prometheus への HTTP タイムアウト                                                                |
| `METRICS_DISK_MOUNTPOINT`      | `/`                                                                                                               | ディスク使用率の対象マウントポイント (node-exporter の `mountpoint` ラベル)                      |
| `METRICS_NETWORK_DEVICE_REGEX` | `^(eth\|en\|ens\|enp).*`                                                                                          | ネットワーク I/O の対象デバイス                                                                  |

#### Prometheus クライアント (`lib/api/self-hosted/metrics/prometheus.ts`)

- `queryRange({ query, start, end, step })` で `GET /api/v1/query_range` を叩き、`AbortSignal.timeout` でタイムアウトします。
- レスポンスは zod で検証し、`{ metric, values: [unix, string][] }[]` を返します。
- URL の資格情報をログやエラーメッセージに出さないよう、エラーは種別 (接続拒否 / タイムアウト / HTTP ステータス) に正規化します。

#### infra-monitoring (`lib/api/self-hosted/metrics/infra-monitoring.ts`)

クエリパラメータ `attributes[]` / `startDate` / `endDate` / `interval` (`1m` | `1h` | `1d`) を受け取り、属性ごとの PromQL を `query_range` で評価します。`step` は interval と同じにします。`[step]` はレート計算のウィンドウで interval に応じて置き換えます。

| 属性                                                                                                             | PromQL (概略)                                                                                                                                     | format     |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------- |
| `cpu_usage`, `avg_cpu_usage`                                                                                     | `100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[step])))`                                                                                | `%`        |
| `max_cpu_usage`                                                                                                  | `100 * (1 - min(rate(node_cpu_seconds_total{mode="idle"}[step])))`                                                                                | `%`        |
| `cpu_usage_busy_{system,user,iowait,irqs,other,idle}`                                                            | `100 * sum(rate(node_cpu_seconds_total{mode=~...}[step])) / sum(rate(node_cpu_seconds_total[step]))` (`irqs` = irq+softirq、`other` = nice+steal) | `%`        |
| `ram_usage`                                                                                                      | `100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)`                                                                         | `%`        |
| `ram_usage_total` / `_available` / `_free` / `_used` / `_cache_and_buffers` / `_swap`                            | `node_memory_*` (used = Total - Available、cache = Cached + Buffers、swap = SwapTotal - SwapFree)                                                 | `bytes`    |
| `swap_usage`                                                                                                     | `100 * (1 - SwapFree / SwapTotal)` (SwapTotal = 0 のときは 0)                                                                                     | `%`        |
| `disk_fs_size` / `disk_fs_avail` / `disk_fs_used`                                                                | `node*filesystem*{size,avail,size-avail}\_bytes{mountpoint="<MOUNTPOINT>", fstype!~"tmpfs                                                         | overlay"}` | `bytes` |
| `disk_fs_used_wal`                                                                                               | postgres-exporter のカスタムメトリクス `pg_wal_size_bytes`                                                                                        | `bytes`    |
| `disk_fs_used_system`                                                                                            | `disk_fs_used - pg_database_size - disk_fs_used_wal` (0 未満は 0)                                                                                 | `bytes`    |
| `pg_database_size`                                                                                               | `sum(pg_database_size_bytes)`                                                                                                                     | `bytes`    |
| `disk_iops_read` / `disk_iops_write`                                                                             | `sum(rate(node_disk_{reads,writes}_completed_total{device!~"loop.*\|dm-.*"}[step]))`                                                              | `number`   |
| `disk_bytes_read` / `disk_bytes_written`                                                                         | `sum(rate(node_disk_{read,written}_bytes_total{...}[step]))`                                                                                      | `bytes`    |
| `network_receive_bytes` / `network_transmit_bytes`                                                               | `sum(rate(node_network_{receive,transmit}_bytes_total{device=~"<NETWORK_DEVICE_REGEX>"}[step]))`                                                  | `bytes`    |
| `pg_stat_database_num_backends`                                                                                  | `sum(pg_stat_database_numbackends)`                                                                                                               | `number`   |
| `max_db_connections`                                                                                             | `pg_settings_max_connections`                                                                                                                     | `number`   |
| `disk_io_budget`, `disk_io_consumption`, `disk_io_usage`, `client_connections_*`, `supavisor_connections_active` | 未対応。空の series を返す                                                                                                                        | -          |

レスポンスは属性数が 1 なら `InfraMonitoringSingleResponse`、2 以上なら `InfraMonitoringMultiResponse` の形にします。各 series の `total` は合計、`totalAverage` は平均、`yAxisLimit` は `%` なら 100、それ以外は最大値です。値は Cloud と同じく文字列で返します。`period_start` は ISO 8601 (UTC) です。

未知の属性名は 400 にします (allowlist は enum から生成)。

#### usage.api-counts (`lib/api/self-hosted/metrics/usage-api-counts.ts`)

`interval` (`1hr` | `1day` | `7day`) を受け取り、`components/ui/Logs/logs.utils.ts` の `CHART_INTERVALS` と同じ範囲を集計します。

| interval | 範囲         | step |
| -------- | ------------ | ---- |
| `1hr`    | 直近 60 分   | 1m   |
| `1day`   | 直近 24 時間 | 1h   |
| `7day`   | 直近 7 日    | 1d   |

サービス別のリクエスト数は次の PromQL で取得します。

- Envoy: `sum(increase(envoy_cluster_upstream_rq_completed{envoy_cluster_name="<cluster>"}[step]))`。クラスタ名は `rest` / `auth` / `storage` / `realtime` (`docker/volumes/api/envoy/cds.yaml`)
- Kong: `sum(increase(kong_http_requests_total{service=~"<regex>"}[step]))` (Kong 3 系) または `sum(increase(kong_http_status{service=~"<regex>"}[step]))` (Kong 2.8 系)。両方を `or` で束ねて片方が無くても動くようにします。サービス名の対応は `rest-v1.*|graphql-v1` / `auth-v1.*` / `storage-v1` / `realtime-v1.*` (`docker/volumes/api/kong.yml`)

レスポンスは `data/analytics/project-log-stats-query.ts` の型 `{ result: { timestamp, total_rest_requests, total_auth_requests, total_storage_requests, total_realtime_requests }[] }` に合わせます。データが無い時刻は 0 で埋めます。

#### deployment-mode

`pages/api/platform/deployment-mode.ts` の応答に次を追加します。

- `metrics_enabled: boolean` (`METRICS_PROMETHEUS_URL` が非空かどうか)。Compute カードと Observability チャートのゲート
- `usage_api_counts_source: 'prometheus' | 'logflare' | 'disabled'` (`METRICS_REQUESTS_SOURCE` の解決結果)。Requests グラフのゲート

クライアント側は新規フック `hooks/misc/useSelfHostedMetrics.ts` で `useDeploymentModeQuery` を読み、`{ isMetricsEnabled, isUsageChartEnabled }` を返します (platform ビルドでは両方 false)。

### 4.3 クライアント側

- **Requests グラフ**: `Home.tsx` の `usage` セクションのゲートを `IS_PLATFORM || isUsageChartEnabled` にします。`UsageSection` は既存の `ProjectUsageSection` がそのまま使われます (`useCheckEntitlements` はセルフホストで undefined を返し、既定 interval は `1day` になります)。
- **Compute カード**: `components/interfaces/ProjectHome/SelfHostedCompute/SelfHostedComputeStat.tsx` を新規追加し、`TopSection.tsx` の `SelfHostedServiceStatus` の隣に `metricsEnabled` のときだけマウントします。`useInfraMonitoringAttributesQuery` で `avg_cpu_usage` / `ram_usage` / `disk_fs_used` / `disk_fs_size` / `pg_stat_database_num_backends` / `max_db_connections` を直近 5 分・interval `1m` で取得し、最新値を `SingleStat` に表示します。`HoverCard` で各値の内訳を出します。ポーリング間隔は 30 秒です。純粋関数 (最新値の取り出し、パーセント整形) は `SelfHostedComputeStat.utils.ts` に分離してテストします。
- **Observability > Database**: 変更なし。`infra-monitoring` がデータを返すことで既存チャートが表示されます。

### 4.4 セキュリティ

- Prometheus と exporter のポートはホストに公開しません。
- `node-exporter` はホストの `/` を読み取り専用でマウントします。Docker socket は使いません。
- `postgres-exporter` の接続文字列は compose 内の環境変数のみで、Studio には渡しません。
- Studio の API ルートは PromQL を固定テンプレートから組み立て、ユーザー入力は属性名 (allowlist) と日時 (ISO 8601 の検証) と interval (enum) のみ受け付けます。ユーザー入力を PromQL 文字列に直接連結しません。
- 本ルート群は `hosted-api-allowlist.ts` に追加しないため、platform ビルドでは 404 のままです。

## 5. テスト

- `lib/api/self-hosted/metrics/*.test.ts`: PromQL 生成 (属性ごと)、Prometheus 応答から `InfraMonitoringResponse` への変換 (単一 / 複数属性、欠損時刻の 0 埋め、`totalAverage` 計算)、`usage.api-counts` の interval ごとの範囲と step、未知属性の 400
- `tests/pages/api/platform/projects/[ref]/infra-monitoring.test.ts`: `METRICS_PROMETHEUS_URL` 未設定時のスタブ応答、設定時の Prometheus 呼び出し (fetch をモック)、405
- `hooks/misc/useSelfHostedMetricsEnabled.test.ts`
- `SelfHostedComputeStat.utils.test.ts`

## 6. 実装手順

1. `docker/docker-compose.metrics.yml`、`docker/volumes/metrics/prometheus.yml`、`docker/volumes/metrics/postgres-exporter-queries.yaml`、Envoy admin 変更、Kong override 変更
2. `lib/api/self-hosted/constants.ts` へ環境変数追加、`lib/api/self-hosted/metrics/{prometheus,infra-monitoring,usage-api-counts}.ts`
3. `infra-monitoring.ts` ルートと `[name].ts` ルートの分岐、`deployment-mode` の拡張
4. `useSelfHostedMetricsEnabled`、`Home.tsx` ゲート、`SelfHostedComputeStat`、`TopSection.tsx` マウント
5. テストと `apps/studio/turbo.jsonc` の env 追加 (`METRICS_*`)
6. `docker/CONFIG.md` に `METRICS_*` を追記

## 7. 未確定事項

- 本番 (Kong 2.8.1) で `kong_http_status` の `service` ラベルが期待通りに付くかは実機で確認が必要です。
- 本番には Logflare 1.31.2 + Vector が稼働しています。`METRICS_REQUESTS_SOURCE=logflare` で Logflare の `usage.api-counts` エンドポイントが Postgres バックエンドで正しく集計されるかも実機で確認します。
- `node-exporter` がホストの `/` を読むため、Studio が表示する CPU / メモリはコンテナ単位ではなくホスト全体の値になります。Cloud の「インスタンス」に相当するのはホストそのものなので、この解釈で問題ないと判断しています。
- Prometheus の保持期間 15 日は Observability の最大レンジ (7 日) を満たします。
- `network_receive_bytes` / `network_transmit_bytes` は node-exporter コンテナ自身のネットワーク名前空間の値になります (`/proc/net/dev` は名前空間ごとのため、`--path.rootfs` では回避できません)。現状これらを使うチャートは無いため、`network_mode: host` は採用していません。必要になった時点で検討します。
- Requests グラフのバケットは開始時刻でラベル付けし、進行中のバケットは `now` 時点で経過分だけの窓で別途取得します。完了したバケットは `increase(...[step])` をバケット終了時刻で評価した値です。
- `infra-monitoring` は、レンジ内にサンプルが 1 つも無い系列を `undefined` (値なし) として返します。系列内の欠けだけを 0 で埋めます。exporter が停止しているときに Compute カードが「0%」ではなく「—」を出すための仕様です。
