// server.js (updated: day-wise TSP order + day-centroid hotels + details endpoint)
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const API = process.env.GOOGLE_API_KEY;
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// haversine distance (km)
function hav(lat1, lon1, lat2, lon2){
  const R = 6371;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ------------------ Place text search ------------------
app.get('/api/geocode', async (req,res) => {
  try {
    const q = req.query.q;
    if(!q) return res.json({results:[]});
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&key=${API}`;
    const r = await axios.get(url);
    const out = (r.data.results || []).slice(0,8).map(p => ({
      name: p.name,
      address: p.formatted_address,
      location: p.geometry.location,
      place_id: p.place_id
    }));
    res.json({results: out});
  } catch(e){
    console.error(e?.message);
    res.status(500).json({error: e.message});
  }
});

// ------------------ Nearby places (category) ------------------
app.get('/api/places', async (req,res) => {
  try {
    const {lat,lng,type} = req.query;
    if(!lat || !lng) return res.status(400).json({error:'lat,lng required'});
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=50000&type=${type||'tourist_attraction'}&key=${API}`;
    const r = await axios.get(url);
    const out = (r.data.results || []).map(p => ({
      name: p.name,
      place_id: p.place_id,
      location: p.geometry.location,
      vicinity: p.vicinity,
      rating: p.rating
    }));
    res.json({results: out, next_page_token: r.data.next_page_token || null});
  } catch(e){
    console.error(e?.message);
    res.status(500).json({error: e.message});
  }
});

// ------------------ Hotels near a point ------------------
app.get('/api/hotels', async (req,res) => {
  try {
    const {lat,lng,radius} = req.query;
    if(!lat || !lng) return res.status(400).json({error:'lat,lng required'});
    const rad = radius || 8000;
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${rad}&type=lodging&key=${API}`;
    const r = await axios.get(url);
    const out = (r.data.results || []).map(p => ({
      name: p.name,
      place_id: p.place_id,
      location: p.geometry.location,
      vicinity: p.vicinity,
      rating: p.rating,
      price_level: p.price_level
    }));
    res.json({results: out});
  } catch(e){
    console.error(e?.message);
    res.status(500).json({error: e.message});
  }
});

// ------------------ Place details (photo + description) ------------------
app.get('/api/details', async (req,res) => {
  try {
    const {place_id} = req.query;
    if(!place_id) return res.status(400).json({error:'place_id required'});
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=name,editorial_summary,photos,rating,formatted_address,formatted_phone_number&key=${API}`;
    const r = await axios.get(url);
    const p = r.data.result || {};
    const description = (p.editorial_summary && p.editorial_summary.overview) ? p.editorial_summary.overview : (p.formatted_address || '');
    const photo = (p.photos && p.photos.length) ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photo_reference=${p.photos[0].photo_reference}&key=${API}` : null;
    res.json({ name: p.name||'', description, photo, rating: p.rating||null, phone: p.formatted_phone_number||null });
  } catch(e){
    console.error(e?.message);
    res.status(500).json({error: e.message});
  }
});

// ------------------ TSP helpers (nearest neighbor + 2-opt) ------------------
// compute distance matrix
function computeDistanceMatrix(points){
  const n = points.length;
  const mat = Array.from({length:n},()=>Array(n).fill(0));
  for(let i=0;i<n;i++){
    for(let j=0;j<n;j++){
      if(i===j) mat[i][j]=0;
      else mat[i][j] = hav(points[i].lat, points[i].lng, points[j].lat, points[j].lng);
    }
  }
  return mat;
}
// nearest neighbor from start index
function nearestNeighborOrder(mat, start=0){
  const n = mat.length;
  const order = [start];
  const used = new Array(n).fill(false);
  used[start]=true;
  let cur = start;
  while(order.length < n){
    let best = -1, bd = Infinity;
    for(let j=0;j<n;j++) if(!used[j] && mat[cur][j] < bd){ bd = mat[cur][j]; best=j; }
    if(best===-1) break;
    order.push(best); used[best]=true; cur=best;
  }
  return order;
}
// 2-opt improve: order is array of indices
function twoOpt(order, mat){
  const n = order.length;
  let improved = true;
  while(improved){
    improved = false;
    for(let i=1;i<n-2;i++){
      for(let k=i+1;k<n-1;k++){
        const a = order[i-1], b = order[i], c = order[k], d = order[k+1];
        const delta = (mat[a][c] + mat[b][d]) - (mat[a][b] + mat[c][d]);
        if(delta < -1e-6){
          // reverse segment i..k
          const seg = order.slice(i,k+1).reverse();
          order.splice(i, seg.length, ...seg);
          improved = true;
        }
      }
    }
  }
  return order;
}

// ------------------ Planner: split attractions into days & optimize per-day route ------------------
app.post('/api/plan', async (req,res) => {
  try {
    const {attractions, hotel, days} = req.body;
    if(!Array.isArray(attractions) || attractions.length === 0) return res.status(400).json({error:'attractions required'});
    const D = Math.max(1, Number(days) || 1);

    // normalize attractions to {name, lat, lng, place_id}
    const pts = attractions.map(a => ({
      name: a.name,
      lat: Number(a.lat),
      lng: Number(a.lng),
      place_id: a.place_id || null
    })).filter(p => !isNaN(p.lat) && !isNaN(p.lng));

    // fallback: simple round-robin distribution (we will then optimize order per day)
    const buckets = Array.from({length: D}, ()=>[]);
    for(let i=0;i<pts.length;i++) buckets[i % D].push(pts[i]);

    const plan = [];

    for(let di=0; di<D; di++){
      const dayPlaces = buckets[di] || [];
      if(dayPlaces.length === 0){
        plan.push({ day: di+1, places: [], suggested_hotel: null, hotel_alternatives: [] });
        continue;
      }

      // compute centroid of day
      let la=0, ln=0;
      dayPlaces.forEach(p => { la += p.lat; ln += p.lng; });
      la /= dayPlaces.length; ln /= dayPlaces.length;

      // fetch hotels close to centroid (7000m)
      const hotelsUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${la},${ln}&radius=7000&type=lodging&key=${API}`;
      const hr = await axios.get(hotelsUrl);
      const hotels = (hr.data.results || []).map(h => {
        const loc = h.geometry.location;
        let sum = 0;
        dayPlaces.forEach(p => sum += hav(p.lat, p.lng, loc.lat, loc.lng));
        return {
          name: h.name,
          place_id: h.place_id,
          vicinity: h.vicinity,
          rating: h.rating,
          price_level: h.price_level,
          location: loc,
          avg_distance_km: sum / dayPlaces.length
        };
      });
      hotels.sort((a,b) => a.avg_distance_km - b.avg_distance_km);

      // Plan order: run TSP (NN + 2opt). Choose start index: if hotel provided and within day? else choose nearest to centroid
      // Build points array
      const ptsList = dayPlaces.map(p => ({lat: p.lat, lng: p.lng}));
      const n = ptsList.length;

      // if n==1, trivial
      let orderIdx = [];
      if(n === 1) orderIdx = [0];
      else {
        // compute matrix
        const mat = computeDistanceMatrix(ptsList);
        // pick start candidate: nearest to centroid
        let start=0, bestd=Infinity;
        for(let i=0;i<n;i++){
          const d = hav(ptsList[i].lat, ptsList[i].lng, la, ln);
          if(d < bestd){ bestd = d; start = i; }
        }
        orderIdx = nearestNeighborOrder(mat, start);
        orderIdx = twoOpt(orderIdx, mat);
      }

      const orderedPlaces = orderIdx.map(idx => dayPlaces[idx]);

      // build suggested hotel (closest by avg_distance)
      const suggested = hotels.length ? hotels[0] : null;

      // send top 5 alternatives too
      const alternatives = hotels.slice(1,6);

      plan.push({
        day: di+1,
        places: orderedPlaces,
        suggested_hotel: suggested,
        hotel_alternatives: alternatives
      });
    }

    res.json({ plan });
  } catch(e){
    console.error(e?.message);
    res.status(500).json({error: e.message});
  }
});

// ------------------ start ------------------
app.listen(PORT, ()=> console.log(`Server listening on http://localhost:${PORT}`));
