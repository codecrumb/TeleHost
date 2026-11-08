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
  encrypted and authenticated (AES-GCM, key derived with HKDF from `LINK_SECRET`,
  or from the bot token if that is not set). What is
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
- **Upload auth** (when `UPLOAD_BASIC_USER` / `UPLOAD_BASIC_PASS` are set) is
  constant-time, does not reveal the password length, fails closed if either
  variable is blank or only one is set, and refuses cross-site requests
  (`Sec-Fetch-Site` / `Origin` checks), since browsers resend cached Basic
  credentials on cross-site form posts.
- **Rate limits are passed on, not absorbed.** If Telegram answers 429 the
  worker returns 429 with `Retry-After` immediately (it never sleeps), and the
  browser waits and retries.
- **The Android share target asks before uploading.** `/share-target` accepts a
  file POST, which any website could also send. The service worker only parks
  the files in a temporary cache and redirects to the upload page; the page shows
  a "Upload N shared files?" prompt and uploads nothing without a yes, clearing
  the parked files either way. File names in that prompt are flattened (no
  control characters or forged lines) and shown with their sizes. The worker handles no other request and caches
  nothing else, so it cannot serve stale or tampered pages.
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
- **Changing the link secret breaks existing `/s/` links.** The secret is
  `LINK_SECRET` if set (recommended: `openssl rand -hex 32`, at least 32
  characters; a shorter or blank value is refused rather than used), otherwise
  the bot token. Without `LINK_SECRET`, rotating the bot token breaks them too.
  Plain `/file/` links are never affected. Keys for sealing manifests and signing
  receipts are separate HKDF outputs of that secret.
- **Cleanup on expiry is lazy and rate limited.** Messages are deleted when
  someone opens an expired link, at most once per link per hour per Cloudflare
  location (remembered in the edge cache, and only trusted if the marker reads
  back, since the Cache API can silently do nothing on some domains; without it
  only about one request in five cleans up, and deletes at most 5), one slice of
  up to 40 messages at a time, so hammering an expired link cannot burn the bot's
  rate limit. A link
  nobody opens again keeps its file in the channel, and a file of over 40 parts
  needs visits in more than one hour to be fully cleaned up.
- **Password files rely on password strength.** Anyone holding the ciphertext
  can try passwords offline. A lost password cannot be recovered.
- **Plain chunked files (over 19 MiB, no expiry or password)** keep their part
  links as ordinary public `/file/` links; only files given an expiry or a
  password use the protected `/s/` path, where part ids are never exposed.
- **Big files with an expiry or password cannot resume** an interrupted upload.
  The link itself stops working at once when it expires.
- **`?meta=1` is readable by anyone holding a protected link.** It returns the
  original file name, type, size and the (public) key-derivation parameters even
  for password-protected files, so the name of a protected file is not secret.
  The contents are.
- **A video's thumbnail outlives its expiry.** The (320 px) thumbnail used for
  link previews is an ordinary `/file/` link and stays fetchable after the main
  file's link expires.
- **Third parties see your links.** By default every new link is sent to da.gd or
  tinyurl to be shortened (so for an expiring link the shortener sees the live
  `/s/` address). Choose "None" in `/settings` to avoid that. JSZip (used to zip
  folders) is loaded from cdnjs, pinned with Subresource Integrity.
- **The share prompt is a native `confirm()`.** A cross-site page can still make
  it appear (with sanitised names), attributed to your site; it uploads nothing
  unless someone clicks OK. A custom in-page prompt would make the origin of the
  files clearer.
- **Referer allowlisting is best-effort.** Empty referers always pass, and a
  referer can be forged outside a browser.
- **No script-src Content-Security-Policy on the app's own pages**
  (`index.html`, `join.html`, `unlock.html`, `settings.html`): they use inline
  scripts. A restricted policy (`frame-ancestors`, `base-uri`, `object-src`,
  `form-action`) and `X-Frame-Options: DENY` are applied, and the pages render
  user data (file names, URLs) only through `textContent`. The plain `/join`
  manifests are not sealed, so their contents are treated as untrusted: names
  are never passed to a shell unsanitised, and part paths must be exactly
  `/file/<id>.<ext>`.
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
