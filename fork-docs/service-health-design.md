# セルフホスト向けサービスヘルス表示 設計書

- 対象: `apps/studio` (VorEdgeJP/supabase-customized フォーク)
- ステータス: 設計 (実装前)
- 作成日: 2026-09-02

## 1. 背景と目的

`docker/docker-compose.yml` で完全セルフホストした Studio には、Supabase Cloud で表示される各サービスのヘルス表示がありません。理由は次の 2 点です。

1. ヘルス UI (`components/interfaces/ProjectHome/ServiceStatus.tsx`) を含む `ActivityStats` が `TopSection.tsx` で `IS_PLATFORM &&` の中にあり、セルフホストでは描画されない。
2. ヘルス取得先 `GET /v1/projects/{ref}/health` に対応するセルフホスト用 API ルートが存在せず、Management API も無いため 404 になる。

本機能は、Studio コンテナと同一 Docker ネットワーク上にある各サービスの health エンドポイントをサーバーサイドから直接叩き、プロジェクトホームに各サービスの稼働状態を表示します。

## 2. スコープ

### 含むもの

- 次のサービスのヘルス判定と表示: `db` / `auth` / `rest` / `realtime` / `storage` / `functions` / `meta` / `pooler` (Supavisor) / `api_gateway` (Envoy または Kong)
- セルフホスト専用 API ルート (Next.js pages router と TanStack Start の両ランタイム対応)
- プロジェクトホームへの表示コンポーネント
- `docker/docker-compose.yml` への必要な環境変数追加

### 含まないもの (将来の拡張)

- ログ由来のエラー率 (Observability Overview の `ServiceHealthTable`)。これは Logflare 前提であり、本機能の「プロセス生死」とは意味が異なります。
- CPU / メモリ / ディスクのメトリクス (別設計)
- Docker socket を使ったコンテナ状態の取得 (再起動回数、イメージバージョンなど)
- Supabase CLI (`supabase start`) 環境での対応。CLI ではコンテナ名と構成が異なるため、本機能はセルフホスト (docker-compose) のみを対象にします。

## 3. 設計方針

1. **upstream 追従を最優先にする。** 新機能は新規ファイルに閉じ込め、既存ファイルへの変更は最小限 (1 箇所のマウント追加) に留めます。`IS_PLATFORM` の分岐は書き換えません。
2. **既存のセルフホスト流儀に従う。** サーバー側ロジックは `lib/api/self-hosted/` に置き、`assertSelfHosted()` と `apiWrapper` を使います。環境変数はプレフィックス無しで実行時に読み、`lib/api/self-hosted/constants.ts` にデフォルト付きで集約します。
3. **既存の型に無理に合わせない。** `V1ServiceHealthResponse` の `name` enum には `functions` / `meta` / `api_gateway` が無く、生成ファイルは手編集禁止です。そのため独自のレスポンス型を zod スキーマとして定義し、サーバーとクライアントで共有します。
4. **Envoy を経由せず各サービスへ直接到達する。** Studio コンテナは compose の default ネットワーク上で全サービスにサービス名で到達できます。`supavisor` と `meta` の health はゲートウェイに露出していないため、直接到達が必須です。

## 4. アーキテクチャ

```
Browser
  └─ useSelfHostedServiceHealthQuery()          data/service-status/self-hosted-service-health-query.ts
       └─ GET /api/platform/projects/default/self-hosted/service-health
            ├─ pages/api/platform/projects/[ref]/self-hosted/service-health.ts   (Next 実体)
            └─ routes/api/platform/projects/$ref/self-hosted/service-health.ts   (TanStack ミラー)
                 └─ checkAllServices()          lib/api/self-hosted/service-health.ts
                      ├─ auth      GET http://auth:9999/health
                      ├─ rest      GET http://rest:3001/ready           (admin server)
                      ├─ realtime  GET http://realtime-dev.supabase-realtime:4000/api/tenants/realtime-dev/health  (Bearer ANON_KEY)
                      ├─ storage   GET http://storage:5000/status
                      ├─ functions TCP http://functions:9000/           (HTTP 応答があれば OK)
                      ├─ meta      GET http://meta:8080/health
                      ├─ pooler    GET http://supavisor:4000/api/health
                      ├─ api_gateway GET http://api-gw:8000/            (HTTP 応答があれば OK)
                      └─ db        executeQuery('select version()')     (既存の pg-meta 経由)
```

### 4.1 サーバー側

#### `lib/api/self-hosted/service-health.types.ts` (新規)

サーバーとクライアントで共有する zod スキーマと型です。

```ts
export const SELF_HOSTED_SERVICE_NAMES = [
  'db',
  'auth',
  'rest',
  'realtime',
  'storage',
  'functions',
  'meta',
  'pooler',
  'api_gateway',
] as const

export const selfHostedServiceHealthSchema = z.object({
  name: z.enum(SELF_HOSTED_SERVICE_NAMES),
  status: z.enum(['ACTIVE_HEALTHY', 'UNHEALTHY', 'DISABLED']),
  latencyMs: z.number().nullable(),
  checkedAt: z.string(), // ISO 8601
  error: z.string().optional(), // UNHEALTHY のときの理由 (接続拒否、タイムアウト、HTTP 503 など)
  info: z.record(z.unknown()).optional(), // サービスが返したメタ情報 (auth の version など)
})

export const selfHostedServiceHealthResponseSchema = z.object({
  services: z.array(selfHostedServiceHealthSchema),
})
```

`DISABLED` は「そのサービスの URL が空文字で無効化されている」ことを表します (例: Supavisor を使わない構成)。

#### `lib/api/self-hosted/constants.ts` (追記)

各サービスの内部 URL を環境変数から読み、compose のデフォルトホスト名にフォールバックします。

| 環境変数                         | デフォルト                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `SERVICE_HEALTH_AUTH_URL`        | `http://auth:9999/health`                                                    |
| `SERVICE_HEALTH_REST_URL`        | `http://rest:3001/ready`                                                     |
| `SERVICE_HEALTH_REALTIME_URL`    | `http://realtime-dev.supabase-realtime:4000/api/tenants/realtime-dev/health` |
| `SERVICE_HEALTH_STORAGE_URL`     | `http://storage:5000/status`                                                 |
| `SERVICE_HEALTH_FUNCTIONS_URL`   | `http://functions:9000/`                                                     |
| `SERVICE_HEALTH_META_URL`        | `${STUDIO_PG_META_URL}/health`                                               |
| `SERVICE_HEALTH_POOLER_URL`      | `http://supavisor:4000/api/health`                                           |
| `SERVICE_HEALTH_API_GATEWAY_URL` | `${SUPABASE_URL}/`                                                           |
| `SERVICE_HEALTH_TIMEOUT_MS`      | `3000`                                                                       |

空文字を渡したサービスは `DISABLED` として扱い、fetch しません。

#### `lib/api/self-hosted/service-health.ts` (新規)

- 先頭で `assertSelfHosted()` を呼びます。
- `checkHttpService({ name, url, headers?, acceptAnyResponse? })`: `fetch` に `AbortSignal.timeout(SERVICE_HEALTH_TIMEOUT_MS)` を渡し、`response.ok` なら `ACTIVE_HEALTHY`。`acceptAnyResponse` が真なら HTTP ステータスに関わらず応答があれば `ACTIVE_HEALTHY` (functions と api_gateway 用。functions の `/` は 404 を返し得るため)。接続拒否・タイムアウトは `UNHEALTHY` に `error` を添えます。
- `checkDatabase()`: 既存の `executeQuery({ query: 'select version()', readOnly: true })` を使い、成功なら `ACTIVE_HEALTHY` と `info.version` を返します。SQL は固定文字列のみで、ユーザー入力は一切含めません。
- `checkAllServices(names)`: 要求されたサービスを `Promise.allSettled` で並列実行し、配列を返します。1 つのサービスが遅くてもタイムアウト上限 (既定 3 秒) でレスポンスが返ります。
- モジュールスコープでは `fetch` やクライアント生成を行いません (TanStack サーバーは起動時に全ルートモジュールを評価するため)。

#### `pages/api/platform/projects/[ref]/self-hosted/service-health.ts` (新規)

- `export default (req, res) => apiWrapper(req, res, handler)`
- `GET` のみ。他は 405 と `Allow` ヘッダー (`deployment-mode.ts` と同型)。
- クエリ `services` (CSV) を受け取り、`SELF_HOSTED_SERVICE_NAMES` の allowlist で検証します。未指定なら全サービス。不正な名前は 400。任意 URL への fetch を防ぐため、URL はクライアントから受け取りません。
- `lib/hosted-api-allowlist.ts` には追加しません。追加しないことで platform ビルドでは自動的に 404 になり、セルフホスト限定が保証されます。

#### `routes/api/platform/projects/$ref/self-hosted/service-health.ts` (新規)

`routes/api/platform/deployment-mode.ts` と同じ 10 行のミラーです。`toWebHandler(nextHandler)` で包み `createFileRoute` に登録します。追加後に `pnpm --filter studio dev:tanstack` または `build:tanstack` で `routeTree.gen.ts` を再生成し、生成結果をコミットします。

### 4.2 クライアント側

#### `data/service-status/keys.ts` (追記)

```ts
selfHosted: (projectRef: string | undefined) =>
  ['projects', projectRef, 'service-status', 'self-hosted'] as const,
```

#### `data/service-status/self-hosted-service-health-query.ts` (新規)

- `studio-queries` スキルの `queryOptions` 形式に従います。
- 取得は `fetchHandler(`${BASE_PATH}/api/platform/projects/${ref}/self-hosted/service-health`)` を使い、レスポンスを `selfHostedServiceHealthResponseSchema.parse()` で検証します (`as` キャストを使いません)。`openapi-fetch` の `get()` は Management API の型定義に無いパスのため使いません。
- `enabled: !IS_PLATFORM && Boolean(projectRef)`。
- `refetchInterval`: 全サービスが `ACTIVE_HEALTHY` なら 30 秒、1 つでも `UNHEALTHY` なら 5 秒 (既存 `ServiceStatus.tsx` と同じ考え方)。
- `staleTime: 5000`。

#### `components/interfaces/ProjectHome/SelfHostedServiceStatus/` (新規ディレクトリ)

| ファイル                                | 役割                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `SelfHostedServiceStatus.tsx`           | コンテナ。クエリを呼び、ローディング / エラー / 成功を早期 return で出し分けます。          |
| `SelfHostedServiceStatus.utils.ts`      | 純関数。表示名と説明のマップ、全体ステータスの集約 (`getOverallStatus`)、レイテンシの整形。 |
| `SelfHostedServiceStatus.utils.test.ts` | 上記の網羅テスト。                                                                          |

表示は既存 `ServiceStatus.tsx` の見た目に揃えます。ヘッダーに全体ステータス (Healthy / Unhealthy / Checking) と最終確認時刻、その下にサービスごとの行 (アイコン、名前、ステータス、レイテンシ、エラー理由) を並べます。`StatusIcon` は `ServiceStatus.tsx` から export 済みなので再利用します。エラー表示は `AlertError` を使い、`studio-error-handling` スキルに従います。文言は `copywriting` スキルに従います。

#### マウント (既存ファイルへの唯一の変更)

`components/interfaces/ProjectHome/TopSection.tsx` の `{IS_PLATFORM && (<ActivityStats />)}` の直後に次を追加します。

```tsx
{
  isSelfHosted && (
    <div className="mt-8">
      <SelfHostedServiceStatus />
    </div>
  )
}
```

`isSelfHosted` は `useDeploymentMode()` から取得します。これにより CLI 環境 (`isCli`) では表示されません。`ActivityStats` 全体を出さない理由は、その中の backups / branches / GitHub connections などのクエリがセルフホストに API ルートを持たず 404 を量産するためです。

## 5. docker-compose の変更

`docker/docker-compose.yml` に対して次を変更します。

1. `rest` サービスの `PGRST_ADMIN_SERVER_HOST` を `localhost` から `"*4"` に変更し、admin サーバー (3001) に Studio コンテナから到達できるようにします。ホストへのポート公開は行わないため、外部には露出しません。
2. `studio` サービスに `SERVICE_HEALTH_*` 環境変数を追加します。デフォルト値でも動作するため、実際に追加するのは変更が必要な場合の上書き用としてコメント付きの例に留めます。
3. `studio` サービスの `image:` をフォーク版のイメージに差し替えます。ビルドは `pnpm build:studio:docker` (Next) または `build:studio:docker:tanstack` で行います。

Kong 構成 (`docker-compose.kong.yml`) でも `api-gw` のサービス名は同じため、`api_gateway` チェックはそのまま動作します。

## 6. テスト

`studio-testing` / `studio-mock-api-tests` スキルに従います。

| 対象         | ファイル                                                                     | 内容                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 判定ロジック | `lib/api/self-hosted/service-health.test.ts`                                 | `vi.stubGlobal('fetch', ...)` で 200 / 503 / 接続拒否 / タイムアウトを再現し、各ステータスと `error` を検証。`DISABLED` の分岐。`executeQuery` は `vi.mock` で差し替え。 |
| API ルート   | `tests/pages/api/platform/projects/[ref]/self-hosted/service-health.test.ts` | `node-mocks-http` で 405、200 の shape、`services` の allowlist 違反で 400。                                                                                             |
| クエリフック | `data/service-status/self-hosted-service-health-query.test.tsx`              | `mswServer.use(http.get(...))` で応答をモックし `customRenderHook` + `waitFor`。`IS_PLATFORM` は getter でモックし、platform 時にリクエストが発生しないことを検証。      |
| 純関数       | `SelfHostedServiceStatus.utils.test.ts`                                      | 全体ステータス集約の全分岐、空配列、`DISABLED` の扱い。                                                                                                                  |

コンポーネントテストは純表示のため書きません。E2E はセルフホスト専用機能のため必須としません。

## 7. 実装手順

1. `service-health.types.ts` と `constants.ts` の追記、`service-health.ts` とそのテスト
2. `pages/api` ハンドラーとテスト、`routes/api` ミラー、`routeTree.gen.ts` の再生成
3. `keys.ts` 追記、クエリフックとテスト
4. `SelfHostedServiceStatus` コンポーネント、utils とテスト、`TopSection.tsx` へのマウント
5. `docker-compose.yml` の変更
6. `pnpm --filter studio run lint:ratchet`、`pnpm knip --workspace apps/studio`、`pnpm typecheck`、`pnpm test:studio`、`pnpm test:prettier` を通す
7. フォーク版イメージをビルドし、`docker compose up` で実機確認

## 8. 未確定事項と前提

- Edge Runtime v1.74 の `/_internal/health` が `docker/volumes/functions/main/index.ts` 経由で 200 を返すかは未検証です。そのため `functions` はまず「HTTP 応答があれば OK」とし、実機で `/_internal/health` が使えると分かれば URL を差し替えます。
- Realtime のテナント ID `realtime-dev` はコンテナ名から導出される固定値です。デフォルト URL にハードコードし、変更が必要な場合は環境変数で上書きします。
- `db` のチェックは pg-meta を経由するため、`meta` が落ちていると `db` も `UNHEALTHY` になります。`error` にその旨を含めて区別できるようにします。将来的に `pg` 直結に変える余地があります。
- 機能自体のオン・オフは `useDeploymentMode().isSelfHosted` のみで判定します。利用者が無効化したい要望が出た場合は `packages/common/enabled-features/enabled-features.json` に `self_hosted:service_health` キーを追加し、`ENABLED_FEATURES_SELF_HOSTED_SERVICE_HEALTH=false` で切れるようにします。
