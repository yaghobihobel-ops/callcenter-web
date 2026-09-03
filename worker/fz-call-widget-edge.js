/* firuzo callcenter widget edge cache v2 — version-keyed cache (deploy = fresh edge copy) */
const VER = "v2.0.3";
const ORIGIN = "https://call.firuzo.online/widget.js";
addEventListener("fetch", (event) => {
  event.respondWith(handle(event));
});
async function handle(event) {
  const cache = caches.default;
  const url = new URL(event.request.url);
  if (url.pathname !== "/widget.js") return fetch(event.request);
  const cacheKey = new Request(url.origin + "/widget.js?v=" + VER, event.request);
  let resp = await cache.match(cacheKey);
  if (resp) {
    resp = new Response(resp.body, resp);
    resp.headers.set("X-Edge", "HIT");
    resp.headers.set("X-WVer", VER);
    return resp;
  }
  resp = await fetch(ORIGIN + "?v=" + VER, { cf: { cacheTtl: 0 } });
  if (resp.status === 200) {
    const clone = new Response(resp.body, resp);
    clone.headers.set("Cache-Control", "public, max-age=300, s-maxage=86400");
    clone.headers.set("X-Edge", "MISS");
    clone.headers.set("X-WVer", VER);
    event.waitUntil(cache.put(cacheKey, clone.clone()));
    return clone;
  }
  return resp;
}
