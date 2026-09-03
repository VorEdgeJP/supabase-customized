import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  decodeXmlEntities,
  encodeS3Key,
  listAllObjects,
  listObjects,
  parseListObjectsResponse,
  presignGetObject,
  S3Error,
  type S3Config,
} from './s3'

// Path-style bucket, the shape a self-hosted stack talks to.
const config: S3Config = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  bucket: 'backups-bucket',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  region: 'auto',
  timeoutMs: 10000,
  pathStyle: true,
}

/**
 * The example from the AWS documentation, "Authenticating Requests: Using Query
 * Parameters (AWS Signature Version 4)". It is signed against the virtual-host
 * form of the bucket.
 */
const awsExampleConfig: S3Config = {
  endpoint: 'https://examplebucket.s3.amazonaws.com',
  bucket: 'examplebucket',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  timeoutMs: 10000,
  pathStyle: false,
}

const listResponse = (xml: string) => new Response(xml, { status: 200 })

const objectsXml = (
  contents: string,
  {
    isTruncated = false,
    nextContinuationToken,
  }: { isTruncated?: boolean; nextContinuationToken?: string } = {}
) => `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>backups-bucket</Name>
  <IsTruncated>${isTruncated}</IsTruncated>
  ${nextContinuationToken === undefined ? '' : `<NextContinuationToken>${nextContinuationToken}</NextContinuationToken>`}
  ${contents}
</ListBucketResult>`

const contentsXml = (key: string, size: number, lastModified: string) =>
  `<Contents><Key>${key}</Key><LastModified>${lastModified}</LastModified><ETag>&quot;abc&quot;</ETag><Size>${size}</Size><StorageClass>STANDARD</StorageClass></Contents>`

/** Mirrors what undici throws when nothing is listening on the target port. */
const connectionRefusedError = () => {
  const cause = new Error('connect ECONNREFUSED 172.18.0.9:443')
  Object.assign(cause, { code: 'ECONNREFUSED' })
  return new TypeError('fetch failed', { cause })
}

/** Mirrors what AbortSignal.timeout aborts with. */
const timeoutError = () => new DOMException('The operation was aborted', 'TimeoutError')

describe('api/self-hosted/backups/s3', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('encodeS3Key', () => {
    it('leaves unreserved characters and slashes alone', () => {
      expect(encodeS3Key('db/6h/2026/01/01/20260101T000000Z/globals.sql.age')).toBe(
        'db/6h/2026/01/01/20260101T000000Z/globals.sql.age'
      )
      expect(encodeS3Key('a-z_A-Z.0~9')).toBe('a-z_A-Z.0~9')
    })

    it('encodes spaces, plus signs and other reserved characters as uppercase hex', () => {
      expect(encodeS3Key('db/my backup+file.age')).toBe('db/my%20backup%2Bfile.age')
      expect(encodeS3Key('db/(a)=b&c')).toBe('db/%28a%29%3Db%26c')
    })

    it('encodes multi-byte characters per UTF-8 byte', () => {
      expect(encodeS3Key('db/バックアップ.age')).toBe(
        'db/%E3%83%90%E3%83%83%E3%82%AF%E3%82%A2%E3%83%83%E3%83%97.age'
      )
    })

    it('returns an empty string for an empty key', () => {
      expect(encodeS3Key('')).toBe('')
    })

    it('escapes a percent sign, so a pre-encoded traversal stays literal', () => {
      // WHATWG URL parsing resolves `%2e%2e` as a double-dot path segment, so the
      // percent sign has to be encoded for a key like this to address an object
      // named `%2e%2e` rather than the parent prefix.
      expect(encodeS3Key('storage/current/%2e%2e/%2e%2e/secret')).toBe(
        'storage/current/%252e%252e/%252e%252e/secret'
      )
    })
  })

  describe('decodeXmlEntities', () => {
    it('decodes the named entities S3 escapes', () => {
      expect(decodeXmlEntities('a&amp;b&lt;c&gt;d&quot;e&apos;f')).toBe(`a&b<c>d"e'f`)
    })

    it('decodes decimal and hexadecimal character references', () => {
      expect(decodeXmlEntities('&#65;&#x42;&#X43;')).toBe('ABC')
    })

    it('leaves unknown entities untouched', () => {
      expect(decodeXmlEntities('&nbsp;&amp;')).toBe('&nbsp;&')
    })

    it('does not double-decode an escaped entity', () => {
      expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;')
    })
  })

  describe('presignGetObject', () => {
    it('matches the signature published in the AWS SigV4 query parameter example', () => {
      const url = presignGetObject(
        {
          key: 'test.txt',
          expiresInSeconds: 86400,
          now: new Date('2013-05-24T00:00:00.000Z'),
        },
        awsExampleConfig
      )

      expect(url).toBe(
        'https://examplebucket.s3.amazonaws.com/test.txt?' +
          'X-Amz-Algorithm=AWS4-HMAC-SHA256' +
          '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
          '&X-Amz-Date=20130524T000000Z' +
          '&X-Amz-Expires=86400' +
          '&X-Amz-SignedHeaders=host' +
          '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
      )
    })

    it('addresses the bucket path-style and encodes the key', () => {
      const url = presignGetObject(
        {
          key: 'db/6h/2026/01/01/20260101T000000Z/my db.dump.age',
          expiresInSeconds: 600,
          now: new Date('2026-01-01T00:00:00.000Z'),
        },
        config
      )

      expect(
        url.startsWith(
          'https://account.r2.cloudflarestorage.com/backups-bucket/db/6h/2026/01/01/20260101T000000Z/my%20db.dump.age?'
        )
      ).toBe(true)
      expect(url).toContain('X-Amz-Expires=600')
      expect(url).toContain(
        'X-Amz-Credential=test-access-key%2F20260101%2Fauto%2Fs3%2Faws4_request'
      )
      expect(url).toMatch(/&X-Amz-Signature=[0-9a-f]{64}$/)
    })

    it('produces a different signature for a different key', () => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const first = presignGetObject({ key: 'db/a.age', expiresInSeconds: 600, now }, config)
      const second = presignGetObject({ key: 'db/b.age', expiresInSeconds: 600, now }, config)

      expect(first).not.toBe(second)
    })

    it('signs the response-content-disposition override into the query', () => {
      const now = new Date('2026-01-01T00:00:00.000Z')
      const plain = presignGetObject({ key: 'db/a.age', expiresInSeconds: 600, now }, config)
      const withDisposition = presignGetObject(
        {
          key: 'db/a.age',
          expiresInSeconds: 600,
          now,
          responseContentDisposition: 'attachment; filename="a.age"',
        },
        config
      )

      const query = new URL(withDisposition).searchParams
      expect(query.get('response-content-disposition')).toBe('attachment; filename="a.age"')
      // The override is part of the canonical query, so the signature changes with it.
      expect(query.get('X-Amz-Signature')).not.toBe(
        new URL(plain).searchParams.get('X-Amz-Signature')
      )
      expect(withDisposition).toMatch(/&X-Amz-Signature=[0-9a-f]{64}$/)
    })

    it('keeps a pre-encoded traversal inside the signed path', () => {
      const url = presignGetObject(
        {
          key: 'storage/current/%2e%2e/secret',
          expiresInSeconds: 600,
          now: new Date('2026-01-01T00:00:00.000Z'),
        },
        config
      )

      expect(new URL(url).pathname).toBe('/backups-bucket/storage/current/%252e%252e/secret')
    })

    it('rejects a malformed endpoint without echoing it', () => {
      expect(() =>
        presignGetObject(
          { key: 'db/a.age', expiresInSeconds: 600 },
          { ...config, endpoint: 'not a url' }
        )
      ).toThrowError('The configured endpoint is not a valid URL')
    })
  })

  describe('parseListObjectsResponse', () => {
    it('reads keys, sizes and timestamps', () => {
      const result = parseListObjectsResponse(
        objectsXml(
          contentsXml(
            'db/6h/2026/01/01/20260101T000000Z/globals.sql.age',
            1024,
            '2026-01-01T00:05:00.000Z'
          )
        )
      )

      expect(result).toEqual({
        objects: [
          {
            key: 'db/6h/2026/01/01/20260101T000000Z/globals.sql.age',
            size: 1024,
            lastModified: '2026-01-01T00:05:00.000Z',
          },
        ],
        isTruncated: false,
      })
    })

    it('decodes XML entities in keys', () => {
      const result = parseListObjectsResponse(
        objectsXml(contentsXml('db/a&amp;b/c&lt;d&gt;.age', 1, '2026-01-01T00:00:00.000Z'))
      )

      expect(result.objects[0].key).toBe('db/a&b/c<d>.age')
    })

    it('reports truncation and the continuation token', () => {
      const result = parseListObjectsResponse(
        objectsXml(contentsXml('db/a.age', 1, '2026-01-01T00:00:00.000Z'), {
          isTruncated: true,
          nextContinuationToken: 'token-1',
        })
      )

      expect(result.isTruncated).toBe(true)
      expect(result.nextContinuationToken).toBe('token-1')
    })

    it('returns an empty listing for a response with no contents', () => {
      expect(parseListObjectsResponse(objectsXml(''))).toEqual({ objects: [], isTruncated: false })
    })

    it('skips entries without a key and defaults an unparsable size to zero', () => {
      const result = parseListObjectsResponse(
        objectsXml(
          `<Contents><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>1</Size></Contents>` +
            `<Contents><Key>db/a.age</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>oops</Size></Contents>`
        )
      )

      expect(result.objects).toEqual([
        { key: 'db/a.age', size: 0, lastModified: '2026-01-01T00:00:00.000Z' },
      ])
    })

    it('normalizes a timestamp without milliseconds to ISO 8601', () => {
      const result = parseListObjectsResponse(
        objectsXml(contentsXml('db/a.age', 1, '2026-01-01T00:00:00Z'))
      )

      expect(result.objects[0].lastModified).toBe('2026-01-01T00:00:00.000Z')
    })
  })

  describe('listObjects', () => {
    it('sends a signed ListObjectsV2 request against the path-style bucket', async () => {
      mockFetch.mockResolvedValue(listResponse(objectsXml('')))

      await listObjects({ prefix: 'db/' }, config)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [url, init] = mockFetch.mock.calls[0]
      expect(url).toBe(
        'https://account.r2.cloudflarestorage.com/backups-bucket?list-type=2&max-keys=1000&prefix=db%2F'
      )
      expect(init.method).toBe('GET')
      expect(init.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD')
      expect(init.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
      expect(init.headers.Authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
      )
      expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('passes the continuation token as a sorted query parameter', async () => {
      mockFetch.mockResolvedValue(listResponse(objectsXml('')))

      await listObjects({ prefix: 'db/', continuationToken: 'a/b+c' }, config)

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe(
        'https://account.r2.cloudflarestorage.com/backups-bucket?continuation-token=a%2Fb%2Bc&list-type=2&max-keys=1000&prefix=db%2F'
      )
    })

    it('normalizes an HTTP error to its status without echoing the endpoint', async () => {
      mockFetch.mockResolvedValue(
        new Response('<Error><Key>db/a.age</Key></Error>', { status: 403 })
      )

      const error = await listObjects({ prefix: 'db/' }, config).catch((thrown) => thrown)

      expect(error).toBeInstanceOf(S3Error)
      expect(error.message).toBe('Request failed with HTTP 403')
      expect(error.status).toBe(403)
      expect(error.message).not.toContain('r2.cloudflarestorage.com')
      expect(error.message).not.toContain('db/a.age')
    })

    it('normalizes a timeout', async () => {
      mockFetch.mockRejectedValue(timeoutError())

      const error = await listObjects({ prefix: 'db/' }, config).catch((thrown) => thrown)

      expect(error).toBeInstanceOf(S3Error)
      expect(error.message).toBe('Timed out after 10000ms')
    })

    it('normalizes a refused connection', async () => {
      mockFetch.mockRejectedValue(connectionRefusedError())

      const error = await listObjects({ prefix: 'db/' }, config).catch((thrown) => thrown)

      expect(error).toBeInstanceOf(S3Error)
      expect(error.message).toBe('Connection refused')
    })

    it('does not echo the request URL for an unrecognized failure', async () => {
      mockFetch.mockRejectedValue(
        new TypeError(
          'Failed to parse URL from https://account.r2.cloudflarestorage.com/backups-bucket'
        )
      )

      const error = await listObjects({ prefix: 'db/' }, config).catch((thrown) => thrown)

      expect(error.message).toBe('Could not reach the backup storage')
      expect(error.message).not.toContain('r2.cloudflarestorage.com')
    })
  })

  describe('listAllObjects', () => {
    it('follows the continuation token across pages', async () => {
      mockFetch
        .mockResolvedValueOnce(
          listResponse(
            objectsXml(contentsXml('db/a.age', 1, '2026-01-01T00:00:00.000Z'), {
              isTruncated: true,
              nextContinuationToken: 'token-1',
            })
          )
        )
        .mockResolvedValueOnce(
          listResponse(objectsXml(contentsXml('db/b.age', 2, '2026-01-01T00:01:00.000Z')))
        )

      const result = await listAllObjects({ prefix: 'db/', maxPages: 5 }, config)

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(mockFetch.mock.calls[1][0]).toContain('continuation-token=token-1')
      expect(result.objects.map((object) => object.key)).toEqual(['db/a.age', 'db/b.age'])
      expect(result.isTruncated).toBe(false)
    })

    it('stops at the page cap and reports the listing as truncated', async () => {
      mockFetch.mockImplementation(async () =>
        listResponse(
          objectsXml(contentsXml('db/a.age', 1, '2026-01-01T00:00:00.000Z'), {
            isTruncated: true,
            nextContinuationToken: 'token-1',
          })
        )
      )

      const result = await listAllObjects({ prefix: 'db/', maxPages: 2 }, config)

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(result.objects).toHaveLength(2)
      expect(result.isTruncated).toBe(true)
    })

    it('treats a truncated page without a token as the end of the listing', async () => {
      mockFetch.mockResolvedValue(
        listResponse(
          objectsXml(contentsXml('db/a.age', 1, '2026-01-01T00:00:00.000Z'), { isTruncated: true })
        )
      )

      const result = await listAllObjects({ prefix: 'db/', maxPages: 5 }, config)

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(result.isTruncated).toBe(false)
    })
  })
})
