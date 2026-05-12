require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 8080;
const BASE = "https://www.hellspy.to";

const searchCache = new Map();
const SEARCH_CACHE_TTL = 30 * 60 * 1000; // 30 minut pro vyhledávání

function getCache(key) {
  const c = searchCache.get(key);
  if (c && Date.now() - c.ts < SEARCH_CACHE_TTL) return c.data;
  return null;
}
function setCache(key, data) {
  searchCache.set(key, { data, ts: Date.now() });
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
  "Referer": "https://www.hellspy.to/",
};

async function getMovieTitle(imdbId) {
  const tmdbKey = process.env.TMDB_API_KEY;
  if (!tmdbKey) return null;
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${tmdbKey}&external_source=imdb_id`
    );
    const data = await res.json();
    const item = data.movie_results?.[0] || data.tv_results?.[0];
    return item ? (item.title || item.name) : null;
  } catch (e) {
    return null;
  }
}

async function searchHellspy(query) {
  const cacheKey = `search:${query}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const url = `${BASE}/?query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: HEADERS });
    const html = await res.text();
    const $ = cheerio.load(html);

    const results = [];
    $("a").each((i, el) => {
      const href = $(el).attr("href") || "";
      const title = $(el).text().trim();
      if (href.includes("/video/") && title && title.length > 2) {
        const match = href.match(/\/video\/([^/]+)\/(\d+)/);
        if (match) {
          results.push({
            title: title,
            url: `${BASE}${href}`,
            hash: match[1],
            videoId: match[2],
          });
        }
      }
    });

    const unique = results.filter((v, i, a) => a.findIndex(t => t.url === v.url) === i);
    setCache(cacheKey, unique);
    return unique;
  } catch (e) {
    console.error("Search error:", e.message);
    return [];
  }
}

// Vždy načte ČERSTVÝ stream URL (bez cache - token vyprší)
async function getFreshStreamUrl(hash, videoId) {
  try {
    const url = `${BASE}/video/${hash}/${videoId}`;
    const res = await fetch(url, { headers: HEADERS });
    const html = await res.text();
    const $ = cheerio.load(html);

    let streamUrl = null;

    $("source").each((i, el) => {
      const src = $(el).attr("src");
      if (src && src.includes(".mp4")) streamUrl = src;
    });

    if (!streamUrl) {
      $("script").each((i, el) => {
        const content = $(el).html() || "";
        const mp4Match = content.match(/["'](https?:\/\/[^"']*\.mp4[^"']*)['"]/);
        if (mp4Match && !streamUrl) streamUrl = mp4Match[1];
      });
    }

    if (!streamUrl) {
      const videoSrc = $("video").attr("src");
      if (videoSrc) streamUrl = videoSrc;
    }

    return streamUrl;
  } catch (e) {
    return null;
  }
}

const MANIFEST = {
  id: "cz.hellspy.addon",
  version: "4.0.0",
  name: "🔥 Hellspy CZ",
  description: "Filmy a seriály z Hellspy.to — CZ dabing, CZ titulky",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "tmdb:"],
  catalogs: [],
  behaviorHints: { adult: false, p2p: false },
};

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

app.get("/manifest.json", (req, res) => res.json(MANIFEST));

// DYNAMICKÁ PROXY - načte čerstvý token při každém kliknutí
app.get("/play/:hash/:videoId", async (req, res) => {
  const { hash, videoId } = req.params;
  console.log(`Proxy request pro videoId: ${videoId}`);

  try {
    // Načti čerstvý stream URL
    const streamUrl = await getFreshStreamUrl(hash, videoId);

    if (!streamUrl) {
      return res.status(404).send("Stream nenalezen");
    }

    console.log(`Čerstvý stream URL získán, přesměrovávám...`);

    // Přesměruj na čerstvý stream
    const range = req.headers.range;
    const fetchHeaders = {
      ...HEADERS,
      "Accept": "video/mp4,video/*;q=0.9,*/*;q=0.8",
    };
    if (range) fetchHeaders["Range"] = range;

    const upstream = await fetch(streamUrl, { headers: fetchHeaders });

    res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-cache");

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    const contentRange = upstream.headers.get("content-range");
    if (contentRange) res.setHeader("Content-Range", contentRange);

    if (upstream.status === 206) res.status(206);
    else res.status(200);

    upstream.body.pipe(res);
  } catch (e) {
    console.error("Play proxy chyba:", e.message);
    res.status(500).send("Chyba přehrávání");
  }
});

app.get("/stream/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  const host = `https://${req.get("host")}`;
  console.log(`Stream request: ${type} / ${id}`);

  try {
    let searchQuery = id;

    if (id.startsWith("tt")) {
      const title = await getMovieTitle(id);
      if (title) {
        searchQuery = title;
        console.log(`Název z TMDB: ${searchQuery}`);
      }
    }

    const results = await searchHellspy(searchQuery);
    console.log(`Hellspy výsledky pro "${searchQuery}": ${results.length}`);

    if (results.length === 0) return res.json({ streams: [] });

    const streams = [];

    for (const result of results.slice(0, 8)) {
      const titleLower = result.title.toLowerCase();
      let name = "🎬 Hellspy";

      if (titleLower.includes("cz dab") || titleLower.includes("cz.dab") || titleLower.includes("dabing")) {
        name = "🇨🇿🔊 Hellspy CZ DAB";
      } else if (titleLower.includes("sk dab")) {
        name = "🇸🇰🔊 Hellspy SK DAB";
      } else if (titleLower.includes("cz tit") || titleLower.includes("titulky")) {
        name = "🇨🇿💬 Hellspy CZ TIT";
      } else if (titleLower.includes("cz") || titleLower.includes("czech")) {
        name = "🇨🇿 Hellspy CZ";
      }

      // Dynamická proxy URL - token se načte až při kliknutí
      const playUrl = `${host}/play/${result.hash}/${result.videoId}`;

      streams.push({
        name,
        title: result.title,
        url: playUrl,
        behaviorHints: { notWebReady: false },
      });
    }

    console.log(`Vracím ${streams.length} streamů`);
    res.json({ streams });
  } catch (e) {
    console.error("Error:", e.message);
    res.json({ streams: [] });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Hellspy addon v4 běží na http://localhost:${PORT}`);
  console.log(`📺 Přidej do Stremio: http://localhost:${PORT}/manifest.json`);
});
