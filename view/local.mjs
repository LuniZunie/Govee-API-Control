const util = Object.freeze({
  deg2rad: d => d * (Math.PI / 180), rad2deg: r => r * (180 / Math.PI),

  coordDist: function(lat1, lon1, lat2, lon2) {
    const φ1 = util.deg2rad(lat1), φ2 = util.deg2rad(lat2);
    const Δφ = util.deg2rad(lat2 - lat1), Δλ = util.deg2rad(lon2 - lon1);
    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return c * 6371;
  },

  clamp: (v, min, max) => Math.min(Math.max(v, min), max),

  addTime: (t1, t2) => { // format: HHMM (24-hr)
    let min1 = t1 % 100, min2 = t2 % 100; if (min1 >= 60 || min2 >= 60) return NaN;
    const hr1 = t1 - min1, hr2 = t2 - min2;

    const min12 = (min1 / 60) + (min2 / 60);

    const hr = hr1 + hr2 + (Math.floor(min12) * 100);
    const min = min12 < 0 ? ((1 + min12 % 1) * 60) : (min12 % 1 * 60);

    if (hr < 0) return hr - (60 - min) + 100;
    else return hr + min;
  },

  formatTime: (code) => { // format: HHMM (24-hr)
    const hr = code / 100 | 0, min = code % 100;
    return (hr * 3600000) + (min * 60000);
  },

  proxy: 'http://localhost:3000/proxy',
  client: document.getElementById('output'),
});

const mem = { countdown: 0 };

function error400() {
  util.client.innerText = 'Error 400: Bad Request';
  setTimeout(() => location.reload(), 5000);
}

const initData = await fetch(`${util.proxy}/data`)
  .then(response => response.json()).then(data => console.log(data) || data)
  .catch(error => console.error(error) || error400());

const { CONFIG, DEFINE } = initData.data;
mem.countdown = Date.now() + initData.countdown;

const promises = {
  station: (function() {
    if (navigator.geolocation) {
      let callback;
      const promise = new Promise(res => callback = res);
      navigator.geolocation.getCurrentPosition(async function success(position) {
        const { latitude, longitude } = position.coords;

        const lookup = await fetch(`${CONFIG.weather.api}/points/${latitude},${longitude}`)
          .then(response => response.json()).then(data => console.log('Point: %o', data) || data.properties.observationStations)
          .catch(error => console.error(error) || error400());
        if (lookup === undefined) return undefined;

        const stations = await fetch(lookup)
          .then(response => response.json()).then(data => console.log('Stations: %o', data) || data.features)
          .catch(error => console.error(error) || error400());
        if (stations === undefined) return undefined;

        const station = stations[0];
        console.log('Closest station: %o', `${station.properties.name} [${station.properties.stationIdentifier}] (${util.coordDist(latitude, longitude, ...station.geometry.coordinates.reverse()).toFixed(2)} km)`);
        return callback(`${station.id}/observations/latest`);
      }, console.error);
      return promise;
    } else return undefined;
  })(),
  init: (async function() {
    return await fetch(`${util.proxy}/init`)
      .then(response => response.json()).then(({ data }) => {
        console.log('Initialization: %o', data);
        util.client.innerText = JSON.stringify(data, null, 2);

        return data;
      })
      .catch(error => console.error(error) || error400());
  })(),
}, database = {};

for (const [ k, promise ] of Object.entries(promises))
  promise.then(data => console.log(`Promise "${k}" resolved with: %o`, data) || (database[k] = data));
await Promise.all(Object.values(promises));

async function updateCall() {
  const device = database.init.devices[0]; // get first device //TODO make this dynamic

  const observed = await fetch(database.station).then(r => r.json()).then(v => v.properties).catch(err => console.error(err)); if (observed === undefined) return;
  const { temperature: { value: tempRAW }, visibility: { value: visRAW }, cloudLayers: cloudsRAW, presentWeather: weatherRAW } = observed; // get raw relevant readings

  const importantWeather = Object.keys(CONFIG.weather.present.scene);
  const weatherSCENE = weatherRAW.filter(event => importantWeather.includes(event.weather)); // possible weather scenes
  if (weatherSCENE.length) {
    const name = CONFIG.weather.present.scene[weatherSCENE[0].weather] ?? CONFIG.weather.present.scene['#default']; // default fallback should never happen

    let scene;
    for (const inst of [ 'lightScene', 'diyScene' ]) {
      const cap = device.capabilities.find(c => c?.type === 'devices.capabilities.dynamic_scene' && c?.instance === inst); if (cap === undefined) continue;
      const opt = cap.parameters.options.find(opt => opt?.name === name); if (opt === undefined) continue;

      scene = { cap, opt };
      break;
    }

    if (scene !== undefined)
      return await fetch(`${util.proxy}/stack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: device.sku, device: device.device,
          capabilities: [ { path: '/device/control', type: scene.cap.type, instance: scene.cap.instance, value: scene.opt.value } ],
        })
      })
        .then(response => response.json()).then(data => mem.countdown = data.countdown)
        .catch(error => { console.error(error); mem.countdown = 0; });
  }
  const capabilities = [];

  const tempRANGE = device.capabilities.find(c => c?.type === 'devices.capabilities.color_setting' && c?.instance === 'colorTemperatureK')?.parameters?.range;
  if (tempRANGE !== undefined) {
    const tempNORMAL = util.clamp((tempRAW - CONFIG.weather.temperature.range.min) / (CONFIG.weather.temperature.range.max - CONFIG.weather.temperature.range.min), 0, 1);
    const temp = Math.round((tempNORMAL * (tempRANGE.max - tempRANGE.min) + tempRANGE.min) * tempRANGE.precision) / tempRANGE.precision;

    capabilities.push({ path: '/device/control', type: 'devices.capabilities.color_setting', instance: 'colorTemperatureK', value: temp });
  }

  const visRANGE = device.capabilities.find(c => c?.type === 'devices.capabilities.range' && c?.instance === 'brightness')?.parameters?.range;
  if (visRANGE !== undefined) {
    const visNORMAL = util.clamp((visRAW - CONFIG.weather.visibility.range.min) / (CONFIG.weather.visibility.range.max - CONFIG.weather.visibility.range.min), 0, 1);
    const vis = Math.round((visNORMAL * (visRANGE.max - visRANGE.min) + visRANGE.min) * visRANGE.precision) / visRANGE.precision;

    capabilities.push({ path: '/device/control', type: 'devices.capabilities.range', instance: 'brightness', value: vis });
  }

  if (capabilities.length)
    return await fetch(`${util.proxy}/stack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku: device.sku, device: device.device,
        capabilities
      })
    })
      .then(response => response.json()).then(data => mem.countdown = data.countdown)
      .catch(error => { console.error(error); mem.countdown = 0; });

  return undefined;
}

async function update() {
  await updateCall();
  setTimeout(update, Math.max(mem.countdown, 1000)); // minimum of 500ms delay to not overwork CPU and server
}
setTimeout(update, mem.countdown - Date.now());

async function getSchoolStatus() {
  const date = new Date();
  const day = date.getDate(); if (day === 0 || day === 6) return false; // Saturday or Sunday
  const month = date.getMonth(); if (month === 6) return false; // July

  const status = {
    calendar: fetch(`http://localhost:3000/hcpss/calendar`, { method: 'GET' })
      .then(r => r.text()).then(function(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const today = doc.querySelector('table.calendar > tbody > tr > td.active');
        if (today.classList.contains('closed-day')) return false;
        else return true; // assume normal operating day
      })
      .catch(err => console.error(err) || true), // assume normal operating day
    code: fetch(`http://localhost:3000/hcpss/status`, { method: 'GET' })
      .then(r => r.text()).then(function(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const status = doc.querySelector('section#status-block > div > h2 > span.status-date + span');
        for (const [ pattern, modifier ] of Object.entries(DEFINE.hcpss.status_codes))
          if (new RegExp(pattern, 'i').test(status.textContent)) {
            if (modifier === -1) return false; // schools closed
            else return +modifier || true; // number of hours to delay with fallback to normal operating day
          }

        return true; // assume normal operating day
      })
      .catch(err => console.error(err) || true), // assume normal operating day
  };

  await Promise.allSettled(Object.values(status));
  const { calendar, code } = status;
  if (calendar === false || code === false) return false; // schools closed
  else return code; // delayed opening or normal operating day
}

async function getAlarmTime() {
  const Δ = (function(status) {
    if (status === false) return CONFIG.max_start_time; // schools closed, time to turn on no matter what

    const t = util.addTime(CONFIG.hcpss.start_time, -CONFIG.hcpss.time_before_school); // normal start time (school start - time needed before school)
    if (status === true) return t; // return normal time
    else return util.addTime(t, status); // return delayed time
  })(await getSchoolStatus());

  const Δms = util.formatTime(Δ);
  return new Date().setHours(0, 0, 0, 0).valueOf() + Δms;
}

console.log(new Date(await getAlarmTime()));