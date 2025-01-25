const { data: { constant, config }, countdown } = window.imported;

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

  findScene(device, sceneName) {
    let scene;
    for (const inst of [ 'lightScene', 'diyScene' ]) {
      const cap = device.capabilities.find(c => c?.type === 'devices.capabilities.dynamic_scene' && c?.instance === inst); if (cap === undefined) continue;
      const opt = cap.parameters.options.find(opt => opt?.name === sceneName); if (opt === undefined) continue;

      scene = { cap, opt };
      break;
    }

    return scene;
  },

  client: document.getElementById('output'),
});

const memory = {
  countdown: Date.now() + countdown,
  schoolStart: null, location: {},
  luminaryData: { date: null },
  sceneChange: { phase: null, time: 0, scene: null }
}, common = {
  api: location.origin + config.api.path,
  apiGovee: location.origin + config.api.path + config.api.govee.path,
};

function error400() {
  util.client.innerText = 'Error 400: Bad Request';
  setTimeout(() => location.reload(), 5000);
}

const promises = {
  station: (function() {
    if (navigator.geolocation) {
      let callback;
      const promise = new Promise(res => callback = res);
      navigator.geolocation.getCurrentPosition(async function success(position) {
        const { latitude, longitude } = position.coords;
        memory.location = { latitude, longitude };

        const lookup = await fetch(`${constant.api.weather.location}/points/${latitude},${longitude}`)
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
    return await fetch(common.apiGovee + config.api.govee.map.devices.path, { method: 'GET' })
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

async function updateCall(updatePromises) {
  let device;
  if ('index' in config.device.use) device = database.init.devices[config.device.use.index]; // get specific device
  else if ('sku' in config.device.use && 'mac_address' in config.device.use)
    device = database.init.devices.find(d => d.sku === config.device.use.sku && d.device === config.device.use.mac_address); // get specific device
  device ??= database.init.devices[0]; // default to first device

  updatePromises.push(updateSchoolStart()); updatePromises.push(updateLuminaryData()); // parallel call to update start time and sun/moon data

  let phaseName = 'sleep', phasePercent = null; // default to off
  if (memory.luminaryData.data !== undefined && memory.schoolStart !== undefined) {
    const solar = (function(sundata) {
      const { rise, set } = config.source.luminary.sun;

      const rtn = { rise: {}, set: {} };
      for (const data of sundata) {
        let { phen, time } = data; time = +time.replace(/\D/g, ''); // remove non-digits

        if (rise.start.phenomenon === phen) rtn.rise.start = util.addTime(time, rise.start.offset);
        if (rise.end.phenomenon === phen) rtn.rise.end = util.addTime(time, rise.end.offset);

        if (set.start.phenomenon === phen) rtn.set.start = util.addTime(time, set.start.offset);
        if (set.end.phenomenon === phen) rtn.set.end = util.addTime(time, set.end.offset);
      }

      return rtn;
    })(memory.luminaryData.data.properties.data.sundata);

    const lunar = (function(moondata) {
      const { rise, set } = config.source.luminary.moon;

      const rtn = { rise: {}, set: {} };
      for (const data of moondata) {
        let { phen, time } = data; time = +time.replace(/\D/g, ''); // remove non-digits

        if (rise.start.phenomenon === phen) rtn.rise.start = util.addTime(time, rise.start.offset);
        if (rise.end.phenomenon === phen) rtn.rise.end = util.addTime(time, rise.end.offset);

        if (set.start.phenomenon === phen) rtn.set.start = util.addTime(time, set.start.offset);
        if (set.end.phenomenon === phen) rtn.set.end = util.addTime(time, set.end.offset);
      }

      return rtn;
    })(memory.luminaryData.data.properties.data.moondata);

    const date = new Date(); // get current time
    phaseName = config.device.phase.list
      .find((function(phase) {
        let { start, end } = phase.time;
        if (typeof start === 'string') start = this.var[start]; if (!this.valid(start)) return false;
        if (typeof end === 'string') end = this.var[end]; if (!this.valid(end)) return false;

        // check if current time is within phase
        if (start > end && (this.now >= start || this.now < end)) return this.setPercent(start, end, true); // cross midnight
        else if (this.now >= start && this.now < end) return this.setPercent(start, end, false);
      }).bind({
        var: {
          "school.start": memory.schoolStart,

          "sunrise.start": solar.rise.start, "sunrise.end": solar.rise.end, "sunset.start": solar.set.start, "sunset.end": solar.set.end,
          "moonrise.start": lunar.rise.start, "moonrise.end": lunar.rise.end, "moonset.start": lunar.set.start, "moonset.end": lunar.set.end,
        },
        valid(t) { return Number.isInteger(t) && t >= 0 && t <= 2400 && t % 100 < 60; },
        setPercent(start, end, crossMidnight) {
          const convert = t => t % 100 + Math.floor(t / 100) * 60; start = convert(start); end = convert(end); // convert to minutes

          const now = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + date.getMilliseconds() / 60000; // more precise percentage
          if (crossMidnight) {
            const len = 1440 - start + end; // 1440 minutes in a day
            if (now < start) phasePercent = (1440 - start + now) / len;
            else phasePercent = (now - start) / len;
          } else phasePercent = (now - start) / (end - start);

          return 1;
        },
        now: date.getHours() * 100 + date.getMinutes(),
      }))?.name ?? config.device.phase.default; // default fallback
  }

  if (phasePercent !== null) console.log(`${new Date().toLocaleString()}: %o (%s)`, phaseName, `${(phasePercent * 100).toFixed(2)}%`);
  else console.log(`${new Date().toLocaleString()}: calibrating...`);

  const phase = config.device.phase.list.find(p => p.name === phaseName);
  if (phase.scenes || phase.scene) {
    const scenes = phase.scenes ?? [ phase.scene ]; // single scene or multiple scenes
    if (memory.sceneChange.phase !== phaseName || (phase.scenes && Date.now() >= memory.sceneChange.time)) {
      let { min, max } = config.device.scene.duration.range; (min = util.formatTime(min)), (max = util.formatTime(max));
      memory.sceneChange.time = Date.now() + Math.floor(Math.random() * (max - min + 1)) + min;

      const sceneName = scenes[Math.floor(Math.random() * scenes.length)]; const scene = util.findScene(device, sceneName);
      if (scene !== undefined) {
        if (sceneName === memory.sceneChange.scene) return; // skip if same scene`

        return await fetch(common.apiGovee + config.api.govee.map.controller.path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sku: device.sku, device: device.device,
            capabilities: [ { path: '/device/control', type: scene.cap.type, instance: scene.cap.instance, value: scene.opt.value } ],
          })
        })
          .then(response => response.json()).then(data => { memory.countdown = data.countdown; memory.sceneChange.phase = phaseName; memory.sceneChange.scene = sceneName; })
          .catch(error => { console.error(error); memory.countdown = 0; });
      }
    }
  } else {
    delete memory.sceneChange.phase; delete memory.sceneChange.scene;
    switch (phaseName) {
      case 'daylight': { // daylight mode, adjust lights based on weather
        const observed = await fetch(database.station).then(r => r.json()).then(v => v.properties).catch(err => console.error(err)); if (observed === undefined) return;
        const { temperature: { value: tempRAW }, visibility: { value: visRAW }, cloudLayers: cloudsRAW, presentWeather: weatherRAW } = observed; // get raw relevant readings

        { // weather
          const weather = weatherRAW.map(ev => ev.weather); // get weather condition of each weather event

          const scene = config.source.weather.present.scene.list.find(s => weather.includes(s.condition))?.scene; // get scene based on weather condition
          const value = scene ? util.findScene(device, scene) : undefined; // find scene in device capabilities
          if (value)
            return await fetch(common.apiGovee + config.api.govee.map.controller.path, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sku: device.sku, device: device.device,
                capabilities: [ { path: '/device/control', type: value.cap.type, instance: value.cap.instance, value: value.opt.value } ],
              })
            })
              .then(response => response.json()).then(data => memory.countdown = data.countdown)
              .catch(error => { console.error(error); memory.countdown = 0; });
        }

        const capabilities = [];
        { // temperature
          const deviceRange = device.capabilities.find(c => c?.type === 'devices.capabilities.color_setting' && c?.instance === 'colorTemperatureK')?.parameters?.range;
          if (deviceRange) {
            const configRange = config.source.weather.temperature.range;
            const normal = util.clamp((tempRAW - configRange.min) / (configRange.max - configRange.min), 0, 1);
            const value = Math.round((normal * (deviceRange.max - deviceRange.min) + deviceRange.min) * deviceRange.precision) / deviceRange.precision;

            capabilities.push({ path: '/device/control', type: 'devices.capabilities.color_setting', instance: 'colorTemperatureK', value });
          }
        }

        { // visibility
          const deviceRange = device.capabilities.find(c => c?.type === 'devices.capabilities.range' && c?.instance === 'brightness')?.parameters?.range;
          if (deviceRange) {
            const configRange = config.source.weather.visibility.range;
            const normal = util.clamp((visRAW - configRange.min) / (configRange.max - configRange.min), 0, 1);
            const value = Math.round((normal * (deviceRange.max - deviceRange.min) + deviceRange.min) * deviceRange.precision) / deviceRange.precision;

            capabilities.push({ path: '/device/control', type: 'devices.capabilities.range', instance: 'brightness', value });
          }
        }

        if (capabilities.length)
          return await fetch(common.apiGovee + config.api.govee.map.controller.path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sku: device.sku, device: device.device, capabilities })
          })
            .then(response => response.json()).then(data => memory.countdown = data.countdown)
            .catch(error => { console.error(error); memory.countdown = 0; });
      } break;
      case 'sunset': { // sunset mode, adjust lights based on cloud cover
        const { r, g, b } = config.device.phase.data.sunset.color;
        const rgb = ((r & 0xFF) << 16) + ((g & 0xFF) << 8) + ((b & 0xFF) << 0);

        let brightness;
        {
          const deviceRange = device.capabilities.find(c => c?.type === 'devices.capabilities.range' && c?.instance === 'brightness')?.parameters?.range;
          const normal = 1 - util.clamp(phasePercent, 0, 1);

          brightness = Math.round((normal * (deviceRange.max - deviceRange.min) + deviceRange.min) * deviceRange.precision) / deviceRange.precision;
        }

        return await fetch(common.apiGovee + config.api.govee.map.controller.path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sku: device.sku, device: device.device,
            capabilities: [
              { path: '/device/control', type: 'devices.capabilities.color_setting', instance: 'colorRgb', value: rgb },
              { path: '/device/control', type: 'devices.capabilities.range', instance: 'brightness', value: brightness },
            ],
          })
        })
          .then(response => response.json()).then(data => memory.countdown = data.countdown)
          .catch(error => { console.error(error); memory.countdown = 0; });
      } break;
    }
  }

  return undefined;
}

async function update() {
  const updatePromises = [];
  await updateCall(updatePromises);

  await Promise.allSettled(updatePromises);

  setTimeout(update, Math.max(memory.countdown, 1000)); // minimum of 500ms delay to not overwork CPU and server
}
setTimeout(update, memory.countdown - Date.now());

async function updateLuminaryData() {
  const date = new Date(); date.setHours(0, 0, 0, 0);
  const { luminaryData } = memory; if (luminaryData.date === date) return false;

  const opts = { date: date.toISOString().split('T')[0], coords: `${memory.location.latitude},${memory.location.longitude}`, tz: date.getTimezoneOffset() / -60 };
  await fetch(`${constant.api.luminary.location}?${new URLSearchParams(opts)}`)
    .then(response => response.json()).then(data => memory.luminaryData = { date, data })
    .catch(error => console.error(error));

  return true;
}

async function updateSchoolStart() {
  const status = await getSchoolStatus(); if (status === false) return memory.schoolStart = -1; // schools closed, time to turn on no matter what

  const t = util.addTime(config.source.hcpss.start.time, config.source.hcpss.start.offset); // normal start time
  if (status === true) return memory.schoolStart = t; // return normal time
  else return memory.schoolStart = util.addTime(t, status); // return delayed time
}

async function getSchoolStatus() {
  const date = new Date();
  const day = date.getDate(); if (day === 0 || day === 6) return false; // Saturday or Sunday
  const month = date.getMonth(); if (month === 6) return false; // July

  const status = {
    calendar: fetch(common.api + config.api.hcpss.path + config.api.hcpss.map.calendar.path, { method: 'GET' })
      .then(r => r.text()).then(function(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const today = doc.querySelector('table.calendar > tbody > tr > td.active');
        if (today.classList.contains('closed-day')) return false;
        else return true; // assume normal operating day
      })
      .catch(err => console.error(err) || true), // assume normal operating day
    code: fetch(common.api + config.api.hcpss.path + config.api.hcpss.map.status.path, { method: 'GET' })
      .then(r => r.text()).then(function(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        const status = doc.querySelector('section#status-block > div > h2 > span.status-date + span');
        for (const code of constant.api.hcpss.status_code.list) {
          if (new RegExp(code.pattern, 'i').test(status.textContent)) {
            if (code.closure) return false; // schools closed
            else return +code.delay || true; // number of hours to delay with fallback to normal operating day
          }
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