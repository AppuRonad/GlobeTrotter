// public/app.js
// Client: request plan (optimized ordering per day) -> ask hotel per day -> compute accurate routes

let map;
let directionsService;
let autocomplete;

let markers = [];
let renderers = [];
let labelMarkers = [];

let clickedPoint = null;
let attractionsList = []; // {name,lat,lng,place_id}
let planFromServer = [];  // will hold server's suggested plan
let selectedHotelPerDay = {}; // {day: {lat,lng,name,place_id}}

window.initMap = function(){
  map = new google.maps.Map(document.getElementById('map'), { center:{lat:20.5937,lng:78.9629}, zoom:6 });
  directionsService = new google.maps.DirectionsService();
  map.addListener('click', (e) => {
    clickedPoint = { lat: e.latLng.lat(), lng: e.latLng.lng() };
    const m = new google.maps.Marker({ map, position: e.latLng, title: 'Clicked location' });
    markers.push(m);
  });
  autocomplete = new google.maps.places.Autocomplete(document.getElementById('customPlace'));
  autocomplete.setFields(['name','geometry','place_id','formatted_address']);
  attachUI();
};

function clearAll(){
  markers.forEach(m=>m.setMap(null)); markers=[];
  renderers.forEach(r=>r.setMap(null)); renderers=[];
  labelMarkers.forEach(m=>m.setMap(null)); labelMarkers=[];
}
function addMarker(lat,lng,title){
  const m = new google.maps.Marker({ map, position:{lat:Number(lat),lng:Number(lng)}, title});
  markers.push(m); return m;
}
function addLabel(lat,lng,label){
  const m = new google.maps.Marker({ map, position:{lat:Number(lat),lng:Number(lng)}, label:{text:label,color:'white',fontWeight:'bold'}, icon:{path:google.maps.SymbolPath.CIRCLE, fillColor:'#1976d2', fillOpacity:1, scale:11, strokeWeight:0} });
  labelMarkers.push(m); return m;
}
function makeLabels(n){ const L=[]; function toLabel(i){ let s=''; i++; while(i>0){ let r=(i-1)%26; s=String.fromCharCode(65+r)+s; i=Math.floor((i-1)/26);} return s;} for(let i=0;i<n;i++) L.push(toLabel(i)); return L; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// ---------------- UI wiring ----------------
function attachUI(){
  document.getElementById('searchPlace').addEventListener('click', async () => {
    const q = document.getElementById('placeInput').value.trim(); if(!q) return alert('Enter a place');
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`); const d = await r.json();
    const box = document.getElementById('placeResults'); box.innerHTML='';
    (d.results||[]).forEach(p=>{
      const div = document.createElement('div'); div.className='list-item';
      div.innerHTML = `<b>${p.name}</b><br>${p.address}<br><button data-lat="${p.location.lat}" data-lng="${p.location.lng}">Select</button>`;
      box.appendChild(div);
      div.querySelector('button').addEventListener('click', ()=>{ map.setCenter({lat:p.location.lat,lng:p.location.lng}); map.setZoom(12); fetchCategory(p.location.lat,p.location.lng,'tourist_attraction'); });
    });
  });

  document.getElementById('fetchCategory').addEventListener('click', () => {
    const cat = document.getElementById('categorySelect').value || 'tourist_attraction';
    const c = map.getCenter(); fetchCategory(c.lat(),c.lng(),cat);
  });

  document.getElementById('addCustomPlace').addEventListener('click', () => {
    const place = autocomplete.getPlace();
    if(!place || !place.geometry) return alert('Select a valid suggestion');
    attractionsList.push({ name: place.name, lat: place.geometry.location.lat(), lng: place.geometry.location.lng(), place_id: place.place_id || null });
    renderAttractionsList();
  });

  document.getElementById('findHotelsOnMap').addEventListener('click', async () => {
    // opens hotel list around clickedPoint (client will use this manually to set hotel for some day)
    let target = clickedPoint;
    if(!target){ const c = map.getCenter(); target = {lat:c.lat(), lng:c.lng()}; }
    const res = await fetch(`/api/hotels?lat=${target.lat}&lng=${target.lng}`);
    const data = await res.json();
    const box = document.getElementById('hotels'); box.innerHTML='';
    data.results.forEach((h,i)=>{
      const div = document.createElement('div'); div.className='list-item';
      div.innerHTML = `<input type="radio" name="hotel_temp" id="ht${i}" data-lat="${h.location.lat}" data-lng="${h.location.lng}" data-name="${h.name}"> <label for="ht${i}"><b>${h.name}</b> ${h.vicinity || ''}</label>`;
      box.appendChild(div);
    });
    // After user picks a hotel radio, they should click a "Use as Day X hotel" button in the day UI (we expose that button in day card)
  });

  // PLAN TRIP: this sends attractions to server which splits into days and optimizes per-day order
  document.getElementById('planTrip').addEventListener('click', async () => {
    if(attractionsList.length===0) return alert('Add attractions first');
    clearAll();
    planFromServer = [];
    selectedHotelPerDay = {};
    const days = Number(document.getElementById('days').value) || 1;
    const mode = document.getElementById('mode').value || 'driving';
    const maxHours = Number(document.getElementById('maxHours').value) || 8;
    // call server
    const res = await fetch('/api/plan', {
      method:'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ attractions: attractionsList, hotel: null, days })
    });
    const data = await res.json();
    planFromServer = data.plan || [];
    // render suggested days + attractions + photos + suggested hotel per day
    await renderSuggestedDays(planFromServer);
  });
}

// ---------------- fetchCategory ----------------
async function fetchCategory(lat,lng,cat){
  const r = await fetch(`/api/places?lat=${lat}&lng=${lng}&type=${cat}`); const d = await r.json();
  (d.results||[]).forEach(p => {
    if(!attractionsList.some(a => a.place_id && p.place_id && a.place_id === p.place_id)){
      attractionsList.push({ name: p.name, lat: p.location.lat, lng: p.location.lng, place_id: p.place_id || null });
    }
  });
  renderAttractionsList();
}

function renderAttractionsList(){
  const box = document.getElementById('attractions'); box.innerHTML='';
  attractionsList.forEach((a,i)=>{
    const div = document.createElement('div'); div.className='list-item';
    div.innerHTML = `<b>${a.name}</b> <button data-i="${i}" class="rem">Remove</button>`;
    box.appendChild(div);
    div.querySelector('.rem').addEventListener('click', ()=>{ attractionsList.splice(i,1); renderAttractionsList(); });
    addMarker(a.lat,a.lng,a.name);
  });
}

// ---------------- render suggested days + photos (ask hotel per day) ----------------
async function renderSuggestedDays(plan){
  const box = document.getElementById('planResult'); box.innerHTML='';
  for(const day of plan){
    const dayDiv = document.createElement('div'); dayDiv.className='day-box';
    const placeCount = (day.places || []).length;
    dayDiv.innerHTML = `<h3>Day ${day.day} — ${placeCount} places</h3><div id="day_${day.day}_places"></div><div id="day_${day.day}_hotel"></div>`;
    box.appendChild(dayDiv);

    // render each attraction with photo+desc (if place_id available)
    const placesContainer = document.getElementById(`day_${day.day}_places`);
    for(const p of (day.places || [])){
      const pDiv = document.createElement('div'); pDiv.className='list-item';
      pDiv.innerHTML = `<b>${p.name}</b><div id="place_det_${day.day}_${(Math.random()*1e6|0)}" class="small"></div>`;
      placesContainer.appendChild(pDiv);
      // fetch details if place_id exists
      if(p.place_id){
        (async ()=>{
          try{
            const r = await fetch(`/api/details?place_id=${p.place_id}`);
            const info = await r.json();
            const det = pDiv.querySelector('.small');
            let html = '';
            if(info.photo) html += `<img src="${info.photo}" class="place-photo">`;
            if(info.description) html += `<div class="small">${info.description}</div>`;
            det.innerHTML = html;
          }catch(e){ /* ignore */ }
        })();
      }
    }

    // suggested hotel UI
    const hotelContainer = document.getElementById(`day_${day.day}_hotel`);
    if(day.suggested_hotel){
      const h = day.suggested_hotel;
      const html = `<div class="list-item"><b>Suggested hotel: </b>${h.name} • avg dist: ${Math.round((h.avg_distance_km||0)*10)/10} km
        <br><button id="acceptHotel_${day.day}">Accept suggested hotel</button>
        <button id="altHotel_${day.day}">Show alternatives</button>
        <div id="altBox_${day.day}"></div>
      </div>`;
      hotelContainer.innerHTML = html;
      document.getElementById(`acceptHotel_${day.day}`).addEventListener('click', ()=>{
        selectedHotelPerDay[day.day] = { lat: h.location.lat, lng: h.location.lng, name: h.name, place_id: h.place_id || null };
        alert(`Hotel accepted for Day ${day.day}: ${h.name}`);
        renderSelectedHotelsSummary();
      });
      document.getElementById(`altHotel_${day.day}`).addEventListener('click', ()=>{
        const altBox = document.getElementById(`altBox_${day.day}`);
        altBox.innerHTML = '';
        (day.hotel_alternatives || []).forEach((ah,ai)=>{
          const div = document.createElement('div'); div.className='list-item';
          div.innerHTML = `<b>${ah.name}</b> • ${Math.round((ah.avg_distance_km||0)*10)/10} km <br>
            <button id="useAlt_${day.day}_${ai}">Use as overnight</button>`;
          altBox.appendChild(div);
          document.getElementById(`useAlt_${day.day}_${ai}`).addEventListener('click', ()=>{
            selectedHotelPerDay[day.day] = { lat: ah.location.lat, lng: ah.location.lng, name: ah.name, place_id: ah.place_id || null };
            alert(`Selected ${ah.name} as hotel for Day ${day.day}`);
            renderSelectedHotelsSummary();
          });
        });
        // offer a "pick on map" option
        const pickMapBtn = document.createElement('button'); pickMapBtn.textContent = 'Pick hotel on map for this day';
        altBox.appendChild(pickMapBtn);
        pickMapBtn.addEventListener('click', ()=> {
          alert('Click anywhere on the map to choose a hotel location, then use the "Find Hotels Near This Location" button and pick a hotel from the list, then click "Use as overnight" on the relevant day.');
        });
      });
    } else {
      hotelContainer.innerHTML = `<div class="small">No suggested hotel for this day</div>`;
    }
  }

  // After rendering all days, show a "Finalize hotels" button allowing user to confirm all days and compute actual routes
  const finalizeDiv = document.createElement('div'); finalizeDiv.style.marginTop='10px';
  finalizeDiv.innerHTML = `<button id="finalizeHotels">Finalize selected hotels for all days and compute routes</button>`;
  document.getElementById('planResult').appendChild(finalizeDiv);
  document.getElementById('finalizeHotels').addEventListener('click', finalizeHotelsAndComputeRoutes);
}

// show small summary of currently selected hotels
function renderSelectedHotelsSummary(){
  const existing = document.getElementById('selectedHotelsSummary');
  if(existing) existing.remove();
  const box = document.createElement('div'); box.id='selectedHotelsSummary';
  box.className='list-item';
  box.innerHTML = '<b>Selected hotels</b><br>';
  for(const d of planFromServer){
    const h = selectedHotelPerDay[d.day];
    box.innerHTML += `Day ${d.day}: ${h ? h.name : '<i>not selected</i>'}<br>`;
  }
  document.getElementById('planResult').prepend(box);
}

// finalize hotels & compute accurate routes using DirectionsService
async function finalizeHotelsAndComputeRoutes(){
  // verify all days have a hotel selected; if not, prompt user
  for(const d of planFromServer){
    if(!selectedHotelPerDay[d.day]){
      // auto-assign suggested hotel if present
      if(d.suggested_hotel){ selectedHotelPerDay[d.day] = { lat: d.suggested_hotel.location.lat, lng: d.suggested_hotel.location.lng, name: d.suggested_hotel.name, place_id: d.suggested_hotel.place_id || null }; }
      else {
        const ok = confirm(`No hotel selected for Day ${d.day}. Do you want to continue and pick later? (Cancel will stop route computation)`);
        if(!ok) return;
      }
    }
  }

  // compute routes day by day
  clearAll();
  const finalResults = [];

  for(const d of planFromServer){
    const places = (d.places || []).filter(p => !isNaN(Number(p.lat)) && !isNaN(Number(p.lng)));
    if(places.length === 0) {
      finalResults.push({ day: d.day, duration_hours:0, distance_km:0, steps: [], places: [] });
      continue;
    }

    const hotel = selectedHotelPerDay[d.day];
    let origin;
    if(hotel) origin = `${hotel.lat},${hotel.lng}`; else origin = `${places[0].lat},${places[0].lng}`;

    const waypoints = places.map(p => ({ location: new google.maps.LatLng(p.lat,p.lng), stopover: true }));

    const request = {
      origin,
      destination: origin,
      waypoints,
      optimizeWaypoints: true,
      travelMode: (document.getElementById('mode').value || 'DRIVING').toUpperCase()
    };

    // DirectionsService call
    const directionsResult = await new Promise((resolve) => {
      directionsService.route(request, (result, status) => {
        if(status === 'OK') resolve({result, status});
        else resolve({result:null, status});
      });
    });

    if(!directionsResult.result){
      console.warn('Directions status', directionsResult.status, 'for day', d.day);
      // fallback approx using haversine: sum pairwise distance in the ordered list
      let approx = 0;
      for(let i=0;i<places.length-1;i++) approx += havDistance(places[i], places[i+1]);
      finalResults.push({ day: d.day, duration_hours: null, distance_km: Math.round(approx*10)/10, steps: [], places });
      continue;
    }

    const route = directionsResult.result.routes[0];
    // render with DirectionsRenderer for real-road visual
    const renderer = new google.maps.DirectionsRenderer({ map, suppressMarkers: true, preserveViewport: true });
    renderer.setDirections(directionsResult.result);
    renderers.push(renderer);

    // compute totals & steps
    let secs=0, meters=0;
    const allSteps = [];
    route.legs.forEach(leg => {
      if(leg.duration && leg.duration.value) secs += leg.duration.value;
      if(leg.distance && leg.distance.value) meters += leg.distance.value;
      leg.steps.forEach(s=>{
        allSteps.push({ instruction: s.instructions.replace(/<[^>]*>/g,''), distance: s.distance?.text || '', duration: s.duration?.text || '' });
      });
    });

    const hours = Math.round((secs/3600)*100)/100;
    const km = Math.round((meters/1000)*10)/10;

    // label visited waypoints as A,B,C... using route.waypoint_order
    const waypointOrder = route.waypoint_order || [];
    const orderedPlaces = waypointOrder.map(idx => places[idx]);
    const labels = makeLabels(orderedPlaces.length);
    orderedPlaces.forEach((p,i)=> addLabel(p.lat,p.lng,labels[i]));

    finalResults.push({ day: d.day, duration_hours: hours, distance_km: km, steps: allSteps, places: orderedPlaces, hotel });
    await sleep(200);
  }

  // show final results including steps
  showFinalResults(finalResults);
}

// ---------------- fallback haversine distance for approx ----------------
function havDistance(a,b){
  const R = 6371;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const aa = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
  return R * c;
}

// ---------------- display final results ----------------
function showFinalResults(days){
  const box = document.getElementById('planResult'); box.innerHTML='';
  days.forEach(d=>{
    const div = document.createElement('div'); div.className='day-box';
    div.innerHTML = `<h3>Day ${d.day}</h3><p>${d.duration_hours ?? 'N/A'} hrs • ${d.distance_km ?? 'N/A'} km</p>`;
    const ol = document.createElement('ol');
    (d.places || []).forEach(p => { const li = document.createElement('li'); li.textContent = p.name; ol.appendChild(li); });
    div.appendChild(ol);

    if(d.steps && d.steps.length){
      const btn = document.createElement('button'); btn.textContent = 'Show steps';
      const stepsDiv = document.createElement('div'); stepsDiv.style.display='none';
      btn.addEventListener('click', ()=> { stepsDiv.style.display = stepsDiv.style.display==='none' ? 'block':'none'; btn.textContent = stepsDiv.style.display==='none' ? 'Show steps' : 'Hide steps'; });
      d.steps.forEach(s => {
        const sdiv = document.createElement('div'); sdiv.className='small';
        sdiv.innerHTML = `• ${s.instruction} <small>(${s.distance} • ${s.duration})</small>`;
        stepsDiv.appendChild(sdiv);
      });
      div.appendChild(btn); div.appendChild(stepsDiv);
    }

    if(d.hotel){
      const hDiv = document.createElement('div'); hDiv.className='list-item'; hDiv.innerHTML = `<b>Overnight hotel:</b> ${d.hotel.name || 'Selected location'}`;
      div.appendChild(hDiv);
    }
    box.appendChild(div);
  });
}
