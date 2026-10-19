export async function onRequest(context) {
    const {
        request,
        env,
        params,
    } = context;

    const url = new URL(request.url);

    // Anti-hotlinking: reject disallowed referers before spending upstream bandwidth
    if (!isRefererAllowed(env, request, url)) {
        return new Response('Hotlinking is not allowed on this deployment.', {
            status: 403,
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        });
    }

    let fileUrl = 'https://telegra.ph/' + url.pathname + url.search
    if (url.pathname.length > 39) { // Path length > 39 indicates file uploaded via Telegram Bot API
        const formdata = new FormData();
        formdata.append("file_id", url.pathname);

        const requestOptions = {
            method: "POST",
            body: formdata,
            redirect: "follow"
        };
        // /file/AgACAgEAAxkDAAMDZt1Gzs4W8dQPWiQJxO5YSH5X-gsAAt-sMRuWNelGOSaEM_9lHHgBAAMCAANtAAM2BA.png
        //get the AgACAgEAAxkDAAMDZt1Gzs4W8dQPWiQJxO5YSH5X-gsAAt-sMRuWNelGOSaEM_9lHHgBAAMCAANtAAM2BA
        console.log(url.pathname.split(".")[0].split("/")[2])
        const filePath = await getFilePath(env, url.pathname.split(".")[0].split("/")[2]);
        console.log(filePath)
        fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
    }

    const response = await fetch(fileUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
    });

    // If the response is OK, proceed with further checks
    if (!response.ok) return response;

    // Log response details
    console.log(response.ok, response.status);

    // Allow the admin page to directly view the image
    const isAdmin = request.headers.get('Referer')?.includes(`${url.origin}/admin`);
    if (isAdmin) {
        return withFileHeaders(response, params.id);
    }

    // Check if KV storage is available
    if (!env.img_url) {
        console.log("KV storage not available, returning image directly");
        return withFileHeaders(response, params.id);  // Directly return image response, terminate execution
    }

    // The following code executes only if KV is available
    let record = await env.img_url.getWithMetadata(params.id);
    if (!record || !record.metadata) {
        // Initialize metadata if it doesn't exist
        console.log("Metadata not found, initializing...");
        record = {
            metadata: {
                ListType: "None",
                Label: "None",
                TimeStamp: Date.now(),
                liked: false,
                fileName: params.id,
                fileSize: 0,
            }
        };
        await env.img_url.put(params.id, "", { metadata: record.metadata });
    }

    const metadata = {
        ListType: record.metadata.ListType || "None",
        Label: record.metadata.Label || "None",
        TimeStamp: record.metadata.TimeStamp || Date.now(),
        liked: record.metadata.liked !== undefined ? record.metadata.liked : false,
        fileName: record.metadata.fileName || params.id,
        fileSize: record.metadata.fileSize || 0,
    };

    // Handle based on ListType and Label
    if (metadata.ListType === "White") {
        return withFileHeaders(response, params.id);
    } else if (metadata.ListType === "Block" || metadata.Label === "adult") {
        const referer = request.headers.get('Referer');
        const redirectUrl = referer ? "https://static-res.pages.dev/teleimage/img-block-compressed.png" : `${url.origin}/block-img.html`;
        return Response.redirect(redirectUrl, 302);
    }

    // Check if WhiteList_Mode is enabled
    if (env.WhiteList_Mode === "true") {
        return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
    }

    // If no metadata or further actions required, moderate content and add to KV if needed
    if (env.ModerateContentApiKey) {
        try {
            console.log("Starting content moderation...");
            const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&url=https://telegra.ph${url.pathname}${url.search}`;
            const moderateResponse = await fetch(moderateUrl);

            if (!moderateResponse.ok) {
                console.error("Content moderation API request failed: " + moderateResponse.status);
            } else {
                const moderateData = await moderateResponse.json();
                console.log("Content moderation results:", moderateData);

                if (moderateData && moderateData.rating_label) {
                    metadata.Label = moderateData.rating_label;

                    if (moderateData.rating_label === "adult") {
                        console.log("Content marked as adult, saving metadata and redirecting");
                        await env.img_url.put(params.id, "", { metadata });
                        return Response.redirect(`${url.origin}/block-img.html`, 302);
                    }
                }
            }
        } catch (error) {
            console.error("Error during content moderation: " + error.message);
            // Moderation failure should not affect user experience, continue processing
        }
    }

    // Only save metadata if content is not adult content
    // Adult content cases are already handled above and will not reach this point
    console.log("Saving metadata");
    await env.img_url.put(params.id, "", { metadata });

    // Return file content
    return withFileHeaders(response, params.id);
}

async function getFilePath(env, file_id) {
    try {
        const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`;
        const res = await fetch(url, {
            method: 'GET',
        });

        if (!res.ok) {
            console.error(`HTTP error! status: ${res.status}`);
            return null;
        }

        const responseData = await res.json();
        const { ok, result } = responseData;

        if (ok && result) {
            return result.file_path;
        } else {
            console.error('Error in response data:', responseData);
            return null;
        }
    } catch (error) {
        console.error('Error fetching file path:', error.message);
        return null;
    }
}
// ALLOWED_REFERERS is a comma-separated hostname allowlist ("example.com,*.example.org").
// Empty referers (direct visits, curl, native apps) always pass, as does the
// deployment's own origin; the feature is off when the var is unset.
function isRefererAllowed(env, request, url) {
    const allowlist = String(env.ALLOWED_REFERERS || '')
        .split(',')
        .map(entry => entry.trim().toLowerCase())
        .filter(Boolean);
    if (allowlist.length === 0) return true;

    const referer = request.headers.get('Referer');
    if (!referer) return true;

    let host;
    try {
        host = new URL(referer).hostname.toLowerCase();
    } catch {
        return false;
    }
    if (host === url.hostname.toLowerCase()) return true;

    return allowlist.some(pattern => {
        if (pattern.startsWith('*.')) {
            const base = pattern.slice(2);
            return host === base || host.endsWith('.' + base);
        }
        return host === pattern;
    });
}

// svg is deliberately absent: serving user uploads as image/svg+xml would
// allow stored XSS on the deployment's own origin.
const CONTENT_TYPES_BY_EXTENSION = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', apng: 'image/apng', bmp: 'image/bmp',
    ico: 'image/x-icon',
    mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg',
    wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
    pdf: 'application/pdf',
};

// Telegram often serves files as application/octet-stream, which breaks
// previews. Derive the type from the extension and serve previewable types inline.
function withFileHeaders(response, filename) {
    const upstreamType = response.headers.get('Content-Type') || '';
    const usable = upstreamType !== '' && !upstreamType.startsWith('application/octet-stream');
    const extension = String(filename).split('.').pop().toLowerCase();
    const correctedType = usable ? null : (CONTENT_TYPES_BY_EXTENSION[extension] || null);
    const effectiveType = correctedType || upstreamType;
    const inline = /^(image|video|audio)\//.test(effectiveType)
        || effectiveType.startsWith('application/pdf');

    if (!correctedType && !inline) return response;

    const headers = new Headers(response.headers);
    if (correctedType) headers.set('Content-Type', correctedType);
    if (inline) {
        headers.set('Content-Disposition', `inline; filename="${String(filename).replace(/["\\\r\n]/g, '_')}"`);
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}
