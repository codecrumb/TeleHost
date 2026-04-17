// State-changing endpoint — restricted to POST to avoid CSRF-style requests
// via simple GETs (images, prefetch, etc.).
export async function onRequest(context) {
  const { request, params, env } = context;

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { "Allow": "POST" },
    });
  }

  const value = await env.img_url.getWithMetadata(params.id);
  if (!value || !value.metadata) {
    return new Response(`Image metadata not found for ID: ${params.id}`, { status: 404 });
  }

  value.metadata.liked = !value.metadata.liked;
  await env.img_url.put(params.id, "", { metadata: value.metadata });

  return new Response(
    JSON.stringify({ success: true, liked: value.metadata.liked }),
    { headers: { "Content-Type": "application/json" } }
  );
}
