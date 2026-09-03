import { createHash, createHmac } from 'node:crypto'

import {
  BACKUPS_MAX_LIST_PAGES,
  BACKUPS_S3_ACCESS_KEY_ID,
  BACKUPS_S3_BUCKET,
  BACKUPS_S3_ENDPOINT,
  BACKUPS_S3_REGION,
  BACKUPS_S3_SECRET_ACCESS_KEY,
  BACKUPS_TIMEOUT_MS,
} from '../constants'

// Minimal S3-compatible client for the self-hosted backup routes. Only two
// operations are needed — ListObjectsV2 and a presigned GET — so they are signed
// here with node:crypto rather than pulling in an SDK. Server-side only: the
// endpoint and the credentials must never reach the browser.

/** Objects returned per ListObjectsV2 page. 1000 is the maximum S3 accepts. */
const MAX_KEYS_PER_PAGE = 1000

const SIGNING_ALGORITHM = 'AWS4-HMAC-SHA256'
const S3_SERVICE = 's3'
/** Requests are signed without hashing the body, which S3 allows over HTTPS. */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

/**
 * Error raised for every failed bucket request. The message is normalized to a
 * category (connection refused, timeout, HTTP status) so that an endpoint, an
 * object key, a credential or a signature can never reach a log line or the
 * browser.
 */
export class S3Error extends Error {
  status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'S3Error'
    this.status = status
  }
}

export type S3Config = {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  timeoutMs: number
  /**
   * Address the bucket as `<endpoint>/<bucket>/<key>`. Cloudflare R2 and most
   * S3-compatible servers support it, so it is the default; the virtual-host
   * form (`<bucket>.<host>/<key>`) is what AWS's published signing examples use.
   */
  pathStyle: boolean
}

export type S3Object = {
  key: string
  size: number
  /** ISO 8601 timestamp of when the object was last written. */
  lastModified: string
}

export type ListObjectsResult = {
  objects: S3Object[]
  isTruncated: boolean
  nextContinuationToken?: string
}

/** Reads the bucket configuration off the environment. */
function getConfig(): S3Config {
  const endpoint = BACKUPS_S3_ENDPOINT
  const bucket = BACKUPS_S3_BUCKET
  const accessKeyId = BACKUPS_S3_ACCESS_KEY_ID
  const secretAccessKey = BACKUPS_S3_SECRET_ACCESS_KEY

  if (
    endpoint === undefined ||
    bucket === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  ) {
    throw new S3Error('Backups are not configured')
  }

  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: BACKUPS_S3_REGION,
    timeoutMs: BACKUPS_TIMEOUT_MS,
    pathStyle: true,
  }
}

const UNRESERVED_CHARACTER = /[A-Za-z0-9\-_.~]/

/**
 * Percent-encodes a value the way SigV4 requires: only `A-Za-z0-9-_.~` survive,
 * every other byte becomes uppercase hex. Multi-byte characters are encoded per
 * UTF-8 byte.
 */
function encodeUriComponentStrict(value: string, { keepSlash }: { keepSlash: boolean }): string {
  const bytes = new TextEncoder().encode(value)
  let encoded = ''

  for (const byte of bytes) {
    const character = String.fromCharCode(byte)
    if (byte < 0x80 && (UNRESERVED_CHARACTER.test(character) || (keepSlash && character === '/'))) {
      encoded += character
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }

  return encoded
}

/** Encodes an object key for a request path, keeping the `/` separators intact. */
export function encodeS3Key(key: string): string {
  return encodeUriComponentStrict(key, { keepSlash: true })
}

/** Encodes one query string name or value, where `/` is encoded as well. */
function encodeQueryComponent(value: string): string {
  return encodeUriComponentStrict(value, { keepSlash: false })
}

/** Builds the canonical query string: entries encoded, then sorted by name. */
function buildCanonicalQueryString(parameters: Record<string, string>): string {
  return Object.entries(parameters)
    .map(([name, value]) => [encodeQueryComponent(name), encodeQueryComponent(value)] as const)
    .sort(([leftName], [rightName]) => (leftName < rightName ? -1 : leftName > rightName ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hmacSha256(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest()
}

/** `YYYYMMDDTHHMMSSZ`, the timestamp format SigV4 signs with. */
function toAmzDate(date: Date): string {
  return `${date.toISOString().replace(/[:-]|\.\d{3}/g, '')}`
}

function getSigningKey({
  secretAccessKey,
  dateStamp,
  region,
}: {
  secretAccessKey: string
  dateStamp: string
  region: string
}): Buffer {
  const dateKey = hmacSha256(`AWS4${secretAccessKey}`, dateStamp)
  const regionKey = hmacSha256(dateKey, region)
  const serviceKey = hmacSha256(regionKey, S3_SERVICE)
  return hmacSha256(serviceKey, 'aws4_request')
}

type SignatureInput = {
  method: string
  host: string
  canonicalPath: string
  canonicalQueryString: string
  canonicalHeaders: string
  signedHeaders: string
  payloadHash: string
  amzDate: string
  dateStamp: string
  region: string
  secretAccessKey: string
}

function calculateSignature({
  method,
  canonicalPath,
  canonicalQueryString,
  canonicalHeaders,
  signedHeaders,
  payloadHash,
  amzDate,
  dateStamp,
  region,
  secretAccessKey,
}: SignatureInput): string {
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const stringToSign = [
    SIGNING_ALGORITHM,
    amzDate,
    `${dateStamp}/${region}/${S3_SERVICE}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join('\n')

  return hmacSha256(getSigningKey({ secretAccessKey, dateStamp, region }), stringToSign).toString(
    'hex'
  )
}

type RequestTarget = {
  /** Value of the `Host` header, which is always part of the signature. */
  host: string
  /** Origin the request is sent to, without a trailing slash. */
  origin: string
  /** Path used both in the URL and in the canonical request. */
  canonicalPath: string
}

/**
 * Resolves the host and the path for a bucket request. A malformed endpoint is
 * rejected here rather than by `fetch`, whose error message repeats the URL.
 */
function resolveTarget(config: S3Config, key?: string): RequestTarget {
  let endpointUrl: URL
  try {
    endpointUrl = new URL(config.endpoint)
  } catch {
    throw new S3Error('The configured endpoint is not a valid URL')
  }

  // An endpoint may carry a base path, e.g. when the bucket sits behind a proxy.
  const basePath = endpointUrl.pathname.replace(/\/+$/, '')
  const keyPath = key === undefined ? '' : `/${encodeS3Key(key)}`
  const bucketPath = config.pathStyle ? `/${encodeQueryComponent(config.bucket)}` : ''
  const canonicalPath = `${basePath}${bucketPath}${keyPath}`

  return {
    host: endpointUrl.host,
    origin: `${endpointUrl.protocol}//${endpointUrl.host}`,
    canonicalPath: canonicalPath.length === 0 ? '/' : canonicalPath,
  }
}

/** Reads a string property off a thrown value without asserting its type. */
function getStringProperty(value: unknown, property: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined

  const candidate = Reflect.get(value, property)
  return typeof candidate === 'string' ? candidate : undefined
}

/**
 * Turns a thrown fetch error into a message that is safe to surface. Aborts
 * surface as a DOMException, which is not an Error subclass in every runtime, so
 * the shape is probed rather than narrowed with instanceof.
 */
export function getS3ErrorMessage(error: unknown, timeoutMs: number): string {
  if (error instanceof S3Error) return error.message

  const name = getStringProperty(error, 'name')
  if (name === 'TimeoutError' || name === 'AbortError') {
    return `Timed out after ${timeoutMs}ms`
  }

  const cause =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'cause') : undefined
  // undici reports the OS-level reason on the cause, not on the thrown TypeError.
  const code = getStringProperty(error, 'code') ?? getStringProperty(cause, 'code')

  if (code === 'ECONNREFUSED') return 'Connection refused'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Host not found'
  if (code === 'ECONNRESET') return 'Connection reset'
  if (code !== undefined) return code

  // The raw message is not echoed: fetch puts the request URL, credentials
  // included, into the message for a malformed URL.
  return 'Could not reach the backup storage'
}

const XML_NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** Restores the characters S3 escapes inside XML text nodes. */
export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const codePoint = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
    }

    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
    }

    return XML_NAMED_ENTITIES[entity] ?? match
  })
}

/** Reads the text of the first `<tag>` inside an XML fragment. */
function readXmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
  return match === null ? undefined : decodeXmlEntities(match[1].trim())
}

/** Normalizes an S3 timestamp to ISO 8601, keeping the raw value if unparsable. */
function toIsoTimestamp(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}

/**
 * Extracts the fields the backup listing needs out of a ListObjectsV2 response.
 * The payload is a flat, well-known shape, so it is read with regular
 * expressions instead of adding an XML parser dependency.
 */
export function parseListObjectsResponse(xml: string): ListObjectsResult {
  const objects: S3Object[] = []

  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const contents = match[1]
    const key = readXmlTag(contents, 'Key')
    if (key === undefined || key.length === 0) continue

    const size = Number.parseInt(readXmlTag(contents, 'Size') ?? '', 10)
    const lastModified = readXmlTag(contents, 'LastModified') ?? ''

    objects.push({
      key,
      size: Number.isFinite(size) && size >= 0 ? size : 0,
      lastModified: toIsoTimestamp(lastModified),
    })
  }

  const nextContinuationToken = readXmlTag(xml, 'NextContinuationToken')

  return {
    objects,
    isTruncated: readXmlTag(xml, 'IsTruncated')?.toLowerCase() === 'true',
    ...(nextContinuationToken === undefined ? {} : { nextContinuationToken }),
  }
}

/** Lists one page of objects under a prefix. */
export async function listObjects(
  { prefix, continuationToken }: { prefix: string; continuationToken?: string },
  config: S3Config = getConfig()
): Promise<ListObjectsResult> {
  const { host, origin, canonicalPath } = resolveTarget(config)

  const now = new Date()
  const amzDate = toAmzDate(now)
  const dateStamp = amzDate.slice(0, 8)

  const canonicalQueryString = buildCanonicalQueryString({
    'list-type': '2',
    'max-keys': String(MAX_KEYS_PER_PAGE),
    prefix,
    ...(continuationToken === undefined ? {} : { 'continuation-token': continuationToken }),
  })

  const canonicalHeaders = [
    `host:${host}`,
    `x-amz-content-sha256:${UNSIGNED_PAYLOAD}`,
    `x-amz-date:${amzDate}`,
  ].join('\n')
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'

  const signature = calculateSignature({
    method: 'GET',
    host,
    canonicalPath,
    canonicalQueryString,
    // A canonical headers block always ends in a newline of its own.
    canonicalHeaders: `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash: UNSIGNED_PAYLOAD,
    amzDate,
    dateStamp,
    region: config.region,
    secretAccessKey: config.secretAccessKey,
  })

  const credential = `${config.accessKeyId}/${dateStamp}/${config.region}/${S3_SERVICE}/aws4_request`
  const authorization = `${SIGNING_ALGORITHM} Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  let response: Response
  try {
    response = await fetch(`${origin}${canonicalPath}?${canonicalQueryString}`, {
      method: 'GET',
      headers: {
        Authorization: authorization,
        'x-amz-content-sha256': UNSIGNED_PAYLOAD,
        'x-amz-date': amzDate,
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    throw new S3Error(getS3ErrorMessage(error, config.timeoutMs))
  }

  if (!response.ok) {
    // The error body repeats the bucket and the key, so only the status is kept.
    try {
      await response.body?.cancel()
    } catch {
      // Canceling an already-consumed body is not an error worth reporting.
    }
    throw new S3Error(`Request failed with HTTP ${response.status}`, response.status)
  }

  let body: string
  try {
    body = await response.text()
  } catch (error) {
    throw new S3Error(getS3ErrorMessage(error, config.timeoutMs))
  }

  return parseListObjectsResponse(body)
}

/**
 * Walks every page under a prefix, up to `maxPages`. A listing that is still
 * truncated at the cap is reported as such instead of being followed further.
 */
export async function listAllObjects(
  { prefix, maxPages = BACKUPS_MAX_LIST_PAGES }: { prefix: string; maxPages?: number },
  config: S3Config = getConfig()
): Promise<{ objects: S3Object[]; isTruncated: boolean }> {
  const objects: S3Object[] = []
  let continuationToken: string | undefined = undefined

  for (let page = 0; page < maxPages; page++) {
    const result: ListObjectsResult = await listObjects({ prefix, continuationToken }, config)
    objects.push(...result.objects)

    if (!result.isTruncated || result.nextContinuationToken === undefined) {
      return { objects, isTruncated: false }
    }

    continuationToken = result.nextContinuationToken
  }

  return { objects, isTruncated: true }
}

/**
 * Builds a presigned GET URL for one object. The signature travels in the query
 * string, so the URL can be handed to the browser and opened directly.
 */
export function presignGetObject(
  {
    key,
    expiresInSeconds,
    now = new Date(),
    responseContentDisposition,
  }: {
    key: string
    expiresInSeconds: number
    now?: Date
    /**
     * Value for the `response-content-disposition` override, e.g.
     * `attachment; filename="postgres.dump.age"`. It is part of the signed
     * query, so the browser downloads the object instead of navigating to it.
     */
    responseContentDisposition?: string
  },
  config: S3Config = getConfig()
): string {
  const { host, origin, canonicalPath } = resolveTarget(config, key)

  const amzDate = toAmzDate(now)
  const dateStamp = amzDate.slice(0, 8)
  const credential = `${config.accessKeyId}/${dateStamp}/${config.region}/${S3_SERVICE}/aws4_request`

  const canonicalQueryString = buildCanonicalQueryString({
    'X-Amz-Algorithm': SIGNING_ALGORITHM,
    'X-Amz-Credential': credential,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
    ...(responseContentDisposition !== undefined
      ? { 'response-content-disposition': responseContentDisposition }
      : {}),
  })

  const signature = calculateSignature({
    method: 'GET',
    host,
    canonicalPath,
    canonicalQueryString,
    canonicalHeaders: `host:${host}\n`,
    signedHeaders: 'host',
    payloadHash: UNSIGNED_PAYLOAD,
    amzDate,
    dateStamp,
    region: config.region,
    secretAccessKey: config.secretAccessKey,
  })

  return `${origin}${canonicalPath}?${canonicalQueryString}&X-Amz-Signature=${signature}`
}
