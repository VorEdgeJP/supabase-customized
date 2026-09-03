# セルフホスト向けデータベースバックアップ表示 設計書

- 対象: `apps/studio` および `docker/` (VorEdgeJP/supabase-customized フォーク)
- ステータス: 設計 (実装と同時進行)
- 作成日: 2026-09-03
- 前提: `fork-docs/service-health-design.md`、`fork-docs/self-hosted-metrics-design.md` の方針を踏襲します

## 1. 背景と目的

Supabase Cloud のプロジェクトホームには「Last backup」カードがあり、Database > Backups ページで日次バックアップの一覧とダウンロードができます。セルフホストでは `/platform/database/{ref}/backups` に相当する API が無く、ナビゲーションの Backups 項目も `IS_PLATFORM` で隠されています。

本番環境ではホスト側の cron が 6 時間ごとに `pg_dump` を取り、age で暗号化して Cloudflare R2 にアップロードしています。Studio はバックアップを取る側ではなく、**R2 上のバックアップを S3 互換 API で列挙して表示する側** に徹します。

### 本番のバックアップ構造 (cron スクリプトより)

| パス                          | 内容                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `db/6h/YYYY/MM/DD/<STAMP>/`   | 6 時間ごとの世代。`STAMP` は `YYYYMMDDTHHMMSSZ` (UTC)                                                                      |
| `db/daily/<STAMP>/`           | 00 時台の世代をサーバーサイドコピー                                                                                        |
| `db/monthly/<STAMP>/`         | 毎月 1 日の世代をサーバーサイドコピー                                                                                      |
| 各世代内のファイル            | `globals.sql.age`、`<database>.dump.age` (DB ごと、`pg_dump -Fc`)、`config.tar.gz.age`、`MANIFEST.sha256`、`DATABASES.txt` |
| `storage/current/`            | Storage ボリュームの rclone sync                                                                                           |
| `storage/deleted/YYYY/MM/DD/` | sync で削除されたファイルの退避先                                                                                          |

すべての `.age` ファイルは age で暗号化されているため、Studio から中身を読むことはできません。ダウンロードは暗号化されたままのファイルを presigned URL で渡します。

## 2. スコープ

### 含むもの

- R2 (S3 互換) の `ListObjectsV2` と presigned GET を行う最小の SigV4 署名実装 (依存追加なし)
- バックアップ一覧 API とダウンロード URL 発行 API (セルフホスト専用、Next と TanStack Start の両ルート)
- プロジェクトホームの「Last backup」カード (最終成功時刻、経過時間、想定間隔を大きく超えたときの警告)
- Database > Backups ページのセルフホスト版 (6h / daily / monthly の一覧、DB 名、合計サイズ、ファイルごとのダウンロード)
- Storage sync の最終更新時刻 (任意、プレフィックスを設定したときのみ)
- ナビゲーション (`DatabaseMenu.utils.tsx`) への Backups 項目の追加
- ユニットテスト

### 含まないもの

- バックアップの実行・復元 (cron と手動 `pg_restore` の運用は変えません)
- age の復号
- 保持ポリシーの管理 (古い世代の削除)
- PITR、Restore to new project (Cloud 専用ページはそのまま `IS_PLATFORM` 配下に残します)
- コマンドパレットの Backups 項目 (`Database.Commands.tsx`) の変更。現状 platform ページへのリンクのままとし、必要になれば別途対応します

## 3. 設計方針

1. **upstream 追従を最優先にする。** 既存ファイルの変更は次に限定します。
   - `components/layouts/DatabaseLayout/DatabaseMenu.utils.tsx` (Backups 項目の追加、数行)
   - `components/interfaces/ProjectHome/TopSection.tsx` (カードのマウント、数行)
   - `pages/api/platform/deployment-mode.ts` と `data/config/deployment-mode-query.ts` (`backups_enabled` の追加)
   - `data/database/keys.ts` (クエリキーの追加)
   - `apps/studio/turbo.jsonc` (env 追加)、`apps/studio/TANSTACK_MIGRATION.md` (チェックリスト追加)
   - `docker/docker-compose.yml` (studio の環境変数追加、既定は空)、`docker/CONFIG.md`
2. **AWS SDK は入れない。** 必要なのは `ListObjectsV2` (GET + XML) と presigned GET だけなので、`node:crypto` で SigV4 を実装します。AWS が公開しているテストベクタで署名を検証します。
3. **Cloud の型に無理に合わせない。** `BackupsResponse` には size や key が無く、`id` は数値です。独自の zod スキーマを `lib/api/self-hosted/backups/backups.types.ts` に定義し、サーバーとクライアントで共有します。
4. **一覧コンポーネントは新規に書く。** Cloud の `BackupsList` / `BackupItem` はデータ取得と platform 専用 mutation を内蔵しているため流用しません。`BackupsEmpty`、`Panel`、`TimestampInfo`、`formatBytes`、ダウンロード用のアンカー生成は流用します。
5. **資格情報を漏らさない。** S3 のエラーメッセージはステータスと種別に正規化し、URL やキーをレスポンスに含めません。ダウンロード URL の発行は、一覧で返したキーと同じ検証 (プレフィックス配下、`..` を含まない) を通したキーだけに許可します。
6. **既存流儀に従う。** `assertSelfHosted()`、`apiWrapper`、`lib/api/self-hosted/constants.ts` へのデフォルト集約、`fetchHandler` + zod による境界の検証、`hosted-api-allowlist.ts` には追加しない (platform ビルドでは 404)。

## 4. アーキテクチャ

```
Browser
  ├─ useSelfHostedBackupsQuery()          data/database/self-hosted-backups-query.ts
  │     └─ GET /api/platform/projects/default/self-hosted/backups
  │          ├─ pages/api/platform/projects/[ref]/self-hosted/backups/index.ts    (Next 実体)
  │          └─ routes/api/platform/projects/$ref/self-hosted/backups/index.ts    (TanStack ミラー)
  │               └─ listBackups()          lib/api/self-hosted/backups/backups.ts
  │                    └─ listObjects()     lib/api/self-hosted/backups/s3.ts  (SigV4 署名付き GET ?list-type=2)
  ├─ useSelfHostedBackupDownloadMutation()  data/database/self-hosted-backup-download-mutation.ts
  │     └─ POST /api/platform/projects/default/self-hosted/backups/download  { key }
  │          └─ presignGetObject()          lib/api/self-hosted/backups/s3.ts  → { fileUrl }
  └─ useDeploymentModeQuery()  → { ..., backups_enabled }
```

### 4.1 環境変数 (`lib/api/self-hosted/constants.ts` に追加)

| 変数                                                        | 既定値                | 説明                                                                              |
| ----------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------- |
| `BACKUPS_S3_ENDPOINT`                                       | (未設定 = 無効)       | S3 互換エンドポイント。R2 は `https://<account_id>.r2.cloudflarestorage.com`      |
| `BACKUPS_S3_BUCKET`                                         | (未設定 = 無効)       | バケット名                                                                        |
| `BACKUPS_S3_ACCESS_KEY_ID` / `BACKUPS_S3_SECRET_ACCESS_KEY` | (未設定 = 無効)       | 読み取り専用トークン (Object Read only、バケット限定)                             |
| `BACKUPS_S3_REGION`                                         | `auto`                | SigV4 のリージョン。R2 は `auto`                                                  |
| `BACKUPS_S3_PREFIX`                                         | `db/`                 | データベースバックアップのプレフィックス                                          |
| `BACKUPS_STORAGE_PREFIX`                                    | (未設定 = 表示しない) | Storage sync のプレフィックス。本番は `storage/current/`                          |
| `BACKUPS_EXPECTED_INTERVAL_HOURS`                           | `6`                   | この 2 倍を超えて新しい世代が無ければ警告                                         |
| `BACKUPS_TIMEOUT_MS`                                        | `10000`               | S3 への HTTP タイムアウト                                                         |
| `BACKUPS_DOWNLOAD_URL_TTL_SECONDS`                          | `600`                 | presigned URL の有効期間                                                          |
| `BACKUPS_MAX_LIST_PAGES`                                    | `20`                  | `ListObjectsV2` のページ上限 (1 ページ 1000 オブジェクト)。超えたら `isTruncated` |

有効判定 `isSelfHostedBackupsEnabled()` は endpoint / bucket / access key / secret の 4 つが揃っているときに true です。

### 4.2 S3 クライアント (`lib/api/self-hosted/backups/s3.ts`)

- パススタイル (`<endpoint>/<bucket>/<key>`) を使います。R2 はパススタイルに対応しています。
- `listObjects({ prefix, continuationToken })`: `GET /<bucket>?list-type=2&prefix=...&continuation-token=...` に `Authorization` ヘッダー方式の SigV4 (`x-amz-content-sha256: UNSIGNED-PAYLOAD`) を付けます。XML は依存を増やさず正規表現で `Contents` (`Key` / `LastModified` / `Size`)、`IsTruncated`、`NextContinuationToken` を抽出し、XML エンティティ (`&amp;` など) を戻します。
- `listAllObjects({ prefix, maxPages })`: ページングをまとめ、`{ objects, isTruncated }` を返します。
- `presignGetObject({ key, expiresInSeconds, responseContentDisposition })`: クエリ文字列方式の presigned URL (`X-Amz-Algorithm` / `X-Amz-Credential` / `X-Amz-Date` / `X-Amz-Expires` / `X-Amz-SignedHeaders=host` / `X-Amz-Signature`) を返します。ダウンロード API は `response-content-disposition=attachment; filename="<ファイル名>"` を署名に含め、ブラウザが画面遷移せずファイルとして保存するようにします。
- キーの URI エンコードは SigV4 の規則 (`A-Za-z0-9-_.~` 以外をエンコード、`/` はパスでは保持) に従います。
- エラーは `S3Error` に正規化します。メッセージは「HTTP 403」「タイムアウト」「接続拒否」のような種別のみで、エンドポイントやキー、署名は含めません。
- 署名の検証には AWS ドキュメントの公開テストベクタ (アクセスキー `AKIAIOSFODNN7EXAMPLE`、`20130524T000000Z`、`examplebucket`、presigned GET `test.txt` の署名 `aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404`) を使います。

### 4.3 一覧の組み立て (`lib/api/self-hosted/backups/backups.ts`)

`BACKUPS_S3_PREFIX` 配下を再帰的に列挙し、キーを次の規則でまとめます。

- `<prefix><tier>/.../<STAMP>/<file>` の形で、`tier` は `6h` / `daily` / `monthly`、`STAMP` は `^\d{8}T\d{6}Z$`。それ以外のキーは無視します。
- 世代 (backup) の `id` は `<tier>/<STAMP>`。`createdAt` は STAMP を ISO 8601 に変換した値、`uploadedAt` はファイルの最大 `LastModified`。
- `files` はファイル名、キー、サイズ、`LastModified`。`totalBytes` は合計。
- `databases` は `<database>.dump.age` から抽出した名前の配列。
- `status` は `MANIFEST.sha256`、`globals.sql.age`、`config.tar.gz.age`、1 つ以上の `.dump.age` が揃っていれば `COMPLETED`、欠けていれば `INCOMPLETE`。
- 並びは `createdAt` の降順。`latest` は `6h` のうち `COMPLETED` の最新 (無ければ null)。
- `isStale` は `latest.createdAt` が `now - BACKUPS_EXPECTED_INTERVAL_HOURS * 2` より古いときに true。
- `storage` は `BACKUPS_STORAGE_PREFIX` が設定されているときのみ、`{ latestModifiedAt, objectCount, totalBytes, isTruncated }`。

レスポンス (`backups.types.ts`、zod):

```ts
{
  backups: Array<{
    id: string; tier: '6h' | 'daily' | 'monthly'; createdAt: string; uploadedAt: string;
    status: 'COMPLETED' | 'INCOMPLETE'; databases: string[]; totalBytes: number;
    files: Array<{ name: string; key: string; size: number; lastModified: string }>
  }>
  latest: Backup | null
  isStale: boolean
  expectedIntervalHours: number
  isTruncated: boolean
  storage: { latestModifiedAt: string | null; objectCount: number; totalBytes: number; isTruncated: boolean } | null
  generatedAt: string
}
```

### 4.4 API ルート

- `GET /api/platform/projects/[ref]/self-hosted/backups`: 無効時は 404 `{ error: { message: 'Backups are not configured' } }`。成功時は上記レスポンス。S3 エラーは 502、バリデーションは 400、他は 500。
- `POST /api/platform/projects/[ref]/self-hosted/backups/download`: body `{ key: string }` を zod で検証し、`BACKUPS_S3_PREFIX` または `BACKUPS_STORAGE_PREFIX` 配下、`..` を含まない、世代のファイル名規則に一致するキーのみ許可します。成功時は `{ fileUrl }`。
- TanStack ミラーは `routes/api/platform/projects/$ref/self-hosted/backups/index.ts` と `download.ts`。`routeTree.gen.ts` は Vite プラグインで再生成します (手編集禁止)。

### 4.5 クライアント

- `hooks/misc/useSelfHostedBackups.ts`: `useDeploymentModeQuery` を読み `{ isBackupsEnabled }` を返します (platform では false)。
- `data/database/self-hosted-backups-query.ts`: `fetchHandler` + zod、`queryOptions`、`enabled: !IS_PLATFORM && Boolean(projectRef)`、`staleTime` 60 秒、`refetchInterval` 5 分。キーは `databaseKeys.selfHostedBackups(projectRef)`。
- `data/database/self-hosted-backup-download-mutation.ts`: `{ projectRef, key }` → `{ fileUrl }`。
- ホームカード `components/interfaces/ProjectHome/SelfHostedBackups/SelfHostedBackupsStat.tsx`: `SingleStat` (`SelfHostedComputeStat` と同じ構造)。ラベル "Last backup"、値は `TimestampInfo` の相対時刻、`href` は `/project/{ref}/database/backups`。`isStale` のときは値を警告色にし、HoverCard に tier / DB 名 / サイズ / status / Storage sync 時刻を出します。純粋関数は `SelfHostedBackupsStat.utils.ts`。
- ページ `pages/project/[ref]/database/backups/index.tsx` (+ `routes/project/$ref/database/backups/index.tsx`): `DefaultLayout` + `DatabaseLayout title="Backups"`。platform ビルドでは `/database/backups/scheduled` にリダイレクトします。本体は `components/interfaces/Database/Backups/SelfHosted/SelfHostedBackupsList.tsx`。
  - 上部に要約行 (最新世代の時刻、想定間隔、Storage sync の最終更新)。`isStale` なら `Admonition` (warning) で「想定より新しいバックアップがありません」。`isTruncated` なら informational な注記。
  - tier の絞り込み (All / 6h / daily / monthly)。
  - 各行: 時刻 (`TimestampInfo`)、tier バッジ、DB 名、合計サイズ、status、"Download" の `DropdownMenu` (ファイルごとに 1 項目、選択で mutation → `fileUrl` を一時アンカーで開く)。
  - 空なら `BackupsEmpty`。
  - 純粋関数 (絞り込み、表示用整形) は `SelfHostedBackups.utils.ts`。
- `DatabaseMenu.utils.tsx`: `IS_PLATFORM && { Backups ... }` の隣に `!IS_PLATFORM && isBackupsEnabled && { name: 'Backups', key: 'backups', url: getDatabaseURL('backups'), shortcutId: SHORTCUT_IDS.NAV_DATABASE_BACKUPS }` を追加します。

### 4.6 セキュリティ

- Studio に渡すのは読み取り専用トークンのみ。cron が使う書き込みトークンは渡しません。
- presigned URL は有効期限付きで、暗号化済みファイルにしか届きません。
- レスポンスとエラーにエンドポイント、アクセスキー、署名を含めません。
- 本ルートは `hosted-api-allowlist.ts` に追加しないため、platform ビルドでは 404 のままです。

## 5. テスト

- `lib/api/self-hosted/backups/s3.test.ts`: AWS テストベクタでの presigned URL 署名一致、`ListObjectsV2` の XML 解析 (エンティティ、ページング)、エラー正規化 (403 / タイムアウト / 接続拒否)、キーの URI エンコード
- `lib/api/self-hosted/backups/backups.test.ts`: キーのグルーピング、tier 判定、status 判定、`latest` / `isStale`、無関係なキーの無視、`isTruncated`、storage 要約
- `tests/pages/api/platform/projects/[ref]/self-hosted/backups/*.test.ts`: 無効時 404、GET 一覧、POST download のキー検証 (プレフィックス外・`..` は 400)、405
- `hooks/misc/__tests__/useSelfHostedBackups.test.ts`
- `SelfHostedBackupsStat.utils.test.ts`、`SelfHostedBackups.utils.test.ts`

## 6. 実装手順

1. `constants.ts` の env、`backups/s3.ts` + テスト
2. `backups/backups.ts` + `backups.types.ts` + テスト
3. API ルート 2 本 (Next + TanStack ミラー、`routeTree.gen.ts` 再生成) + テスト、`deployment-mode` の `backups_enabled`
4. クエリ / mutation フック、`useSelfHostedBackups`、ホームカード、`TopSection.tsx` マウント
5. 一覧ページ、ルート、`TANSTACK_MIGRATION.md`、`DatabaseMenu.utils.tsx`
6. `turbo.jsonc`、`docker-compose.yml`、`docker/CONFIG.md`

## 7. 未確定事項

- R2 の API トークンは Object Read only の権限で、対象バケットに限定して発行してください。バックアップを書き込む cron 側の資格情報を Studio に渡してはいけません。
- オブジェクトストレージのライフサイクルルールはプレフィックスごとに分けてください。バケット全体に単一のルールを掛けると、日次と月次の世代も短間隔の世代と同じ期間で失効します。
- Storage sync の一覧はオブジェクト数が多いと `BACKUPS_MAX_LIST_PAGES` に達します。その場合は `isTruncated` を返し、最終更新時刻は列挙できた範囲での値になります。
- コマンドパレットの Backups 項目は platform のページに飛びます。セルフホストでの整合は別 PR で扱います。
