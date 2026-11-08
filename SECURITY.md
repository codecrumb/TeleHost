# Security notes

TeleHost is a stateless Cloudflare Pages Functions app: files live in a Telegram
channel, the worker only proxies them. There is no database, no KV, no admin
panel and no third-party telemetry.

## Surface

| Route | Purpose | Access |
|---|---|---|
| `POST /upload` | Sends a file (or a chunk) to the Telegram channel | Public, or HTTP Basic if `UPLOAD_BASIC_USER` / `UPLOAD_BASIC_PASS` are set |
| `POST /finalize` | Turns uploaded chunks into one signed `/s/` link (expiry / password) | Same as `/upload` |
| `GET /file/<id>[~<thumb>].<ext>` | Streams a file from Telegram | Public (optional referer allowlist) |
| `GET /s/<id>[.<ext>]` | Expiring / password-protected links backed by a signed manifest, for files of any size (`?meta`, `?part=N` for big ones) | Public (optional referer allowlist) |
| `GET /join/<id>` | Static page that reassembles plain chunked files in the browser | Public |

The only secret is `TG_Bot_Token`. It is used server-side only, is never logged
or sent to clients, and is the HMAC key material for manifests (see below).

## What is protected, and how

- **No client headers reach Telegram.** `/file` and `/s` forward only `Range`
  upstream, with no body. Cookies, `Authorization`, and `Host` are never sent.
- **File ids are validated** (`^[A-Za-z0-9_-]{20,}$`) before any API call and
  URL-encoded in the `getFile` query. Unknown or malformed ids return 404.
- **Uploaded files cannot run script on this origin.** Only images (no SVG),
  video, audio and PDF are served inline, by an allowlist; everything else,
  including `.html`, `.svg`, `.xml` and `.js`, is served as
  `application/octet-stream` with `Content-Disposition: attachment`. All file
  responses carry `X-Content-Type-Options: nosniff`, and inline non-PDF
  responses carry `Content-Security-Policy: sandbox`. (Chrome cannot show PDFs
  under a sandbox policy, so PDFs are the one exception.)
- **Big files are bound to receipts.** Each uploaded chunk comes back with an
  HMAC-signed receipt (file id, message id, size). `/finalize` accepts only
  receipts it can verify, so a client cannot slip arbitrary message ids into a
  manifest, and a receipt can never be mistaken for a manifest signature.
- **Manifests are sealed, not just signed.** `/s/` links point at a manifest
  stored as a document in the channel. Two things can go wrong with that:
  anyone can upload documents through `/upload`, and `/file/<id>` serves any
  document, including a manifest whose id is in the link. So a manifest is
  encrypted and authenticated (AES-GCM, key derived from the bot token). What is
  stored is unreadable, which keeps the real file ids, message ids and file names
  secret from link holders (a plain manifest would let them read the real file id
  and bypass expiry), and any edit or forgery fails authentication, so nobody can
  craft a manifest that serves another file or deletes an arbitrary message.
  Expiry is enforced by the manifest, not by Telegram. This leak existed in an
  earlier unreleased design and was caught by a test before deployment.
- **Password protection is end-to-end.** The browser encrypts the file
  (AES-GCM, key from PBKDF2-SHA256, 600,000 iterations) before upload; big files
  are encrypted part by part under one key, with a fresh IV per part (random
  prefix plus part number) and no file name in the channel. Telegram
  and the worker only see ciphertext and public parameters; the password never
  leaves the browser. The server accepts only sane parameters (iterations
  between 100,000 and 1,000,000, bounded-length salt/IV). The unlock page only
  previews known-safe media types and downloads everything else as plain bytes.
- **Upload auth is constant-time** when Basic auth is enabled.
- **Rate limits are passed on, not absorbed.** If Telegram answers 429 the
  worker returns 429 with `Retry-After` immediately (it never sleeps), and the
  browser waits and retries.
- **IP logging is opt-in.** `LOG_UPLOADER_IP=true` adds the uploader's IP
  (from `CF-Connecting-IP` only, never `X-Forwarded-For`) and country to the
  Telegram message. It is off by default. Telling uploaders is up to the
  operator.

## Known limitations

- **Public uploads are an abuse risk (open, by design).** Without Basic auth
  anyone can store files in your channel and serve them from your domain.
  There is no per-IP limit in the app. Set `UPLOAD_BASIC_USER` /
  `UPLOAD_BASIC_PASS`, or add a Cloudflare rate-limiting rule or Turnstile in
  front of `/upload`.
- **Deleting a Telegram message does not revoke the file.** Measured: a file
  was still downloadable 387 seconds after `deleteMessage` succeeded. Expiry
  deletes the message as cleanup, but the guarantee comes from the manifest
  check. For the same reason there are no one-time downloads.
- **Rotating `TG_Bot_Token` breaks existing `/s/` links**, because the manifest
  key derives from it (plain `/file/` links are unaffected).
- **Cleanup on expiry is lazy.** The message is deleted when someone opens an
  expired link; a link nobody opens again keeps its file in the channel.
- **Password files rely on password strength.** Anyone holding the ciphertext
  can try passwords offline. A lost password cannot be recovered.
- **Plain chunked files (over 19 MiB, no expiry or password)** keep their part
  links as ordinary public `/file/` links; only files given an expiry or a
  password use the protected `/s/` path, where part ids are never exposed.
- **Big files with an expiry or password cannot resume** an interrupted upload,
  and expiry cleanup deletes at most 40 messages per visit (a Workers
  subrequest limit), so a very large expired file may need a second visit to be
  fully cleaned up. The link itself stops working at once.
- **Referer allowlisting is best-effort.** Empty referers always pass, and a
  referer can be forged outside a browser.
- **No Content-Security-Policy on the app's own pages** (`index.html`,
  `join.html`, `unlock.html`): they use inline scripts. They render user data
  (file names, URLs) only through `textContent`.
- **Dev dependencies:** `npm audit` reports 17 findings, all in dev tooling
  (wrangler, jsdom, mocha). The deployed app has **zero** production
  dependencies (`npm audit --omit=dev`: 0 vulnerabilities). Upgrading wrangler
  to a current major may clear some of them (not tested).

## History

An earlier version of this document reviewed the upstream project this was
forked from. Its findings concerned code that no longer exists and are fixed by
removal: a hard-coded third-party Sentry telemetry hook that copied request
headers (including `Authorization`) off-site, and the KV-backed admin panel
(`/api/manage/*`) with its optional Basic auth, `GET`-triggered destructive
endpoints, `console.log(env)` secret leaks, and stack traces in error
responses. The telemetry, admin pages, KV bindings, content-moderation hook,
and the `telegra.ph` fallback have all been deleted.

## Reporting

Please report vulnerabilities privately to the repository owner rather than in
a public issue.
