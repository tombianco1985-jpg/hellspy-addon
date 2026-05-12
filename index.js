require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 8080;
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";

const manifest = {
  id: "cz.hellspy.addon",
  version: "5.0.0",
  name: "🔥 Hellspy CZ",
  description: "Filmy a seriály z Hellspy.to — CZ dabing, CZ titulky",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "tmdb:"],
  catalogs: [],
  behaviorHints: { adult: false, p2p: false },
};

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

app.get("/manifest.json", (req, res) => {
  res.json(manifest);
});

// Získá název filmu z TMDB podle IMDB ID
async function getMovieTitle(imdbId) {
  if (!TMDB_API_KEY) return null;
  try {
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
    const res = await fetch(url);
    const data = await res.json();
    const item = (data.movie_results && data.movie_results[0]) || (data.tv_results && data.tv_results[0]);
    return item ? item.title || item.name : null;
  } catch (e) {
    return null;
  }
}

// Vyhledá na Hellspy a vrátí seznam videí
async function searchHellspy(query) {
  try {
    const url = `https://www.hellspy.to/?query=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "cs-CZ,cs;q=0.9",
        "Accept": "text/html,application/xhtml+xml",
        "Referer": "https://www.hellspy.to/",
      },
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    const results = [];

    $("a.file-title, .search-result a, a[href*='/video/']").each((i, el) => {
      const href = $(el).attr("href");
      const title = $(el).text().trim();
      if (href && href.includes("/video/") && title) {
        const match = href.match(/\/video\/([a-f0-9]+)\/(\d+)/);
        if (match) {
          results.push({ title, hash: match[1], id: match[2] });
        }
      }
    });

    return results;
  } catch (e) {
    console.error("Hellspy search error:", e.message);
    return [];
  }
}

// Získá přímý MP4 URL z Hellspy video stránky
async function getDirectUrl(hash, videoId) {
  try {
    const url = `https://www.hellspy.to/video/${hash}/${videoId}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "cs-CZ,cs;q=0.9",
        "Referer": "https://www.hellspy.to/",
      },
    });
    const html = await res.text();
    const $ = cheerio.load(html);

    // Hledej přímý MP4 link
    let directUrl = null;

    // Metoda 1: source tag
    $("source[type='video/mp4'], source[src*='.mp4']").each((i, el) => {
      if (!directUrl) directUrl = $(el).attr("src");
    });

    // Metoda 2: video tag
    $("video[src*='.mp4']").each((i, el) => {
      if (!directUrl) directUrl = $(el).attr("src");
    });

    // Metoda 3: hledej v JS kódu
    if (!directUrl) {
      const scripts = $("script").map((i, el) => $(el).html()).get().join("\n");
      const mp4Match = scripts.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/);
      if (mp4Match) directUrl = mp4Match[0];
    }

    // Metoda 4: hledej file URL v JSON datech
    if (!directUrl) {
      const jsonMatch = html.match(/"file"\s*:\s*"(https?:[^"]+\.mp4[^"]*)"/);
      if (jsonMatch) directUrl = jsonMatch[1].replace(/\\u0026/g, "&").replace(/\\\//g, "/");
    }

    // Metoda 5: storage URL (s nebo bez https://)
    if (!directUrl) {
      const storageMatch = html.match(/((?:https?:\/\/)?storage\d+\.[^"'\s\\]+\.mp4[^"'\s\\]*)/);
      if (storageMatch) {
        directUrl = storageMatch[1];
        if (!directUrl.startsWith("http")) directUrl = "https://" + directUrl;
        // Dekóduj unicode escape sekvence
        directUrl = directUrl.replace(/\\u0026/g, "&").replace(/\\\//g, "/").replace(/\\$/, "");
      }
    }

    return directUrl;
  } catch (e) {
    console.error("getDirectUrl error:", e.message);
    return null;
  }
}

// Redirect na přímý storage URL
app.get("/pipe/:hash/:videoId", async (req, res) => {
  const { hash, videoId } = req.params;
  console.log(`Pipe request: ${hash}/${videoId}`);

  try {
    const directUrl = await getDirectUrl(hash, videoId);
    if (!directUrl) {
      return res.status(404).send("Video not found");
    }

    const cleanUrl = directUrl.replace(/\\u0026/g, '&').replace(/\\\/\//g, '/').replace(/\\$/,'').replace(/\\"/g,'').trim();
    console.log('Redirecting to: ' + cleanUrl.substring(0, 80));
    res.redirect(302, cleanUrl);
  } catch (e) {
    console.error("Pipe error:", e.message);
    res.status(500).send("Error");
  }
});

app.get("/stream/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  console.log(`Stream request: ${type} / ${id}`);

  try {
    let searchQuery = id;

    // Přeloď IMDB ID na název
    if (id.startsWith("tt")) {
      const baseId = id.split(":")[0];
      const title = await getMovieTitle(baseId);
      if (title) {
        searchQuery = title;
        console.log(`Název z TMDB: ${title}`);
      } else {
        return res.json({ streams: [] });
      }
    }

    const results = await searchHellspy(searchQuery);
    console.log(`Hellspy výsledky pro "${searchQuery}": ${results.length}`);

    const streams = results.slice(0, 8).map((r) => {
      const isCZ = /\bCZ\b|czech|česky|dabing|dabingem/i.test(r.title);
      const isSK = /\bSK\b|slovak|slovensky/i.test(r.title);
      const flag = isCZ ? "🇨🇿" : isSK ? "🇸🇰" : "🎬";
      const label = isCZ ? "Hellspy CZ" : isSK ? "Hellspy SK" : "Hellspy";

      return {
        name: `${flag} ${label}`,
        title: r.title,
        url: `https://123451-8978.rostiapp.cz/pipe/${r.hash}/${r.id}`,
        behaviorHints: { notWebReady: false },
      };
    });

    console.log(`Vracím ${streams.length} streamů`);
    res.json({ streams });
  } catch (e) {
    console.error("Stream error:", e.message);
    res.json({ streams: [] });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Hellspy addon v5 běží na http://localhost:${PORT}`);
  console.log(`📺 Přidej do Stremio: http://localhost:${PORT}/manifest.json`);
});
