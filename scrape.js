/**
 * scrape.js — builds restaurants.json for the "Binnen de Ring" site.
 *
 * What it does:
 *   Lays a grid of small search circles over Amsterdam within the A10 ring,
 *   calls Google Places API (New) "Nearby Search" for each circle, dedupes
 *   the results by place ID, and writes restaurants.json in the exact shape
 *   the website expects.
 *
 * What you need:
 *   1. A Google Cloud project with "Places API (New)" enabled
 *      → https://console.cloud.google.com → APIs & Services → Enable APIs
 *   2. An API key. New accounts get free credit; this full scrape uses
 *      roughly 500–600 requests (~$18 of credit at the Pro tier).
 *
 * How to run:
 *   PLACES_API_KEY=your_key_here node scrape.js
 *
 * Then copy restaurants.json next to index.html and commit both.
 * Note: dishes are NOT included here — Google doesn't provide menus.
 * The site treats "dishes" as optional, so this file works as-is.
 */

const fs = require("fs");

const API_KEY = process.env.PLACES_API_KEY;
if (!API_KEY) {
  console.error("Missing API key. Run with: PLACES_API_KEY=xxx node scrape.js");
  process.exit(1);
}

// ---------------------------------------------------------------
// 1. The search grid: a bounding box around the A10 ring,
//    covered in circles of 450m radius, spaced ~600m apart.
//    (Nearby Search returns max 20 places per call, so circles
//    must be small enough that no circle has >20 restaurants.
//    In dense areas like Centrum/De Pijp some spill-over is
//    possible; shrink RADIUS/STEP there if counts look low.)
// ---------------------------------------------------------------
const BOUNDS = { latMin: 52.327, latMax: 52.395, lngMin: 4.835, lngMax: 4.955 };
const RADIUS = 450;          // meters
const STEP_LAT = 0.0055;     // ~600m
const STEP_LNG = 0.0090;     // ~600m at this latitude

// Rough polygon check: skip grid points clearly outside the ring
// (the box corners are water/harbor). Keep it simple: we accept the
// whole box — Google just returns nothing where there's water.

const gridPoints = [];
for (let lat = BOUNDS.latMin; lat <= BOUNDS.latMax; lat += STEP_LAT) {
  for (let lng = BOUNDS.lngMin; lng <= BOUNDS.lngMax; lng += STEP_LNG) {
    gridPoints.push({ lat, lng });
  }
}
console.log(`Grid: ${gridPoints.length} search circles`);

// ---------------------------------------------------------------
// 2. Field mask — this determines what we pay for. Everything here
//    is in the "Pro" tier except priceRange (Enterprise). If you
//    want to keep it cheaper, remove priceRange from the mask.
// ---------------------------------------------------------------
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.formattedAddress",
  "places.googleMapsUri",
  "places.location",
  "places.primaryType",
  "places.types",
].join(",");

// Google's enum → our 1-4 scale
const PRICE_MAP = {
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

// place type → readable cuisine label (extend as you like)
const CUISINE_MAP = {
  italian_restaurant: "Italian", japanese_restaurant: "Japanese",
  indonesian_restaurant: "Indonesian", thai_restaurant: "Thai",
  chinese_restaurant: "Chinese", indian_restaurant: "Indian",
  french_restaurant: "French", mexican_restaurant: "Mexican",
  korean_restaurant: "Korean", vietnamese_restaurant: "Vietnamese",
  greek_restaurant: "Greek", turkish_restaurant: "Turkish",
  lebanese_restaurant: "Middle Eastern", middle_eastern_restaurant: "Middle Eastern",
  spanish_restaurant: "Spanish", american_restaurant: "American",
  vegan_restaurant: "Vegan", vegetarian_restaurant: "Vegetarian",
  sushi_restaurant: "Japanese", ramen_restaurant: "Japanese",
  pizza_restaurant: "Italian", seafood_restaurant: "Seafood",
  steak_house: "Steakhouse", brazilian_restaurant: "Brazilian",
  hamburger_restaurant: "Burgers", breakfast_restaurant: "Breakfast & Brunch",
  brunch_restaurant: "Breakfast & Brunch",
};

function cuisineFor(place) {
  for (const t of place.types || []) {
    if (CUISINE_MAP[t]) return CUISINE_MAP[t];
  }
  return "Other";
}

// ---------------------------------------------------------------
// 3. The scrape loop
// ---------------------------------------------------------------
const seen = new Map(); // place id -> restaurant object

async function searchCircle(point) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({
      includedTypes: ["restaurant"],
      maxResultCount: 20,
      locationRestriction: {
        circle: { center: { latitude: point.lat, longitude: point.lng }, radius: RADIUS },
      },
    }),
  });
  if (!res.ok) {
    console.error(`  ! ${res.status} at ${point.lat.toFixed(3)},${point.lng.toFixed(3)}: ${await res.text()}`);
    return;
  }
  const data = await res.json();
  for (const p of data.places || []) {
    if (seen.has(p.id)) continue;
    if (!p.rating) continue; // skip unrated places (usually closed/brand new)
    seen.set(p.id, {
      name: p.displayName?.text || "Unknown",
      cuisine: cuisineFor(p),
      priceLevel: PRICE_MAP[p.priceLevel] ?? null, // null = Google has no price data ("price unknown" on the site)
      rating: p.rating,
      reviews: p.userRatingCount || 0,
      neighborhood: "", // optional: fill via reverse geocoding later
      address: (p.formattedAddress || "").replace(/, \d{4} ?[A-Z]{2} Amsterdam.*$/, ""),
      url: p.googleMapsUri,
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      // no "dishes" — added later for restaurants where we have menu data
    });
  }
}

(async () => {
  let done = 0;
  for (const point of gridPoints) {
    await searchCircle(point);
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${gridPoints.length} circles, ${seen.size} restaurants so far`);
    await new Promise(r => setTimeout(r, 120)); // stay well under rate limits
  }
  const list = [...seen.values()].sort((a, b) => b.reviews - a.reviews);
  fs.writeFileSync("restaurants.json", JSON.stringify(list, null, 1));
  console.log(`\nDone: ${list.length} restaurants written to restaurants.json`);
})();
