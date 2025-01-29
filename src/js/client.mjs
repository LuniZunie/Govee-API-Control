import { Time, Angle, GCS, RGB, Utility, proto } from './utility.mjs';
proto.import('Number', 'Object', 'Array.prototype');

import DisplayNumber from './display_number.mjs';

const { data: { constant, config }, countdown } = window.imported;

const utility = new Utility('client', config, constant);

const testTime = { time: 0, init: Date.now() };
window.setTestTime = function(hr = 'now', min = 0, sec = 0, ms = 0) {
  if (hr === 'now') { const d = new Date(); hr = d.getHours(), min = d.getMinutes(), sec = d.getSeconds(), ms = d.getMilliseconds(); }

  testTime.time = (hr * 3600000) + (min * 60000) + (sec * 1000) + ms;
  testTime.init = Date.now();
};
{ const d = new Date(); window.setTestTime(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()); }

const output = document.getElementById('output');

const memory = {
  timer: new Date(countdown),
  sceneChange: { phase: null, time: 0, scene: null }
};

function error400() {
  output.innerText = 'Error 400: Bad Request';
  setTimeout(() => location.reload(), 5000);
}

const promises = {
  station: (function() {
    if (navigator.geolocation) {
      let callback;
      const promise = new Promise(res => callback = res);
      async function success(position) {
        const { latitude, longitude } = position.coords;
        sessionStorage.setItem('location', JSON.stringify({ latitude, longitude }));

        const lookup = await fetch(`${constant.api.weather.location}/points/${latitude},${longitude}`)
          .then(res => res.json())
          .then(data => console.log('Point: %o', data) || data.properties.observationStations)
          .catch(err => console.error(err) || error400());
        if (lookup === undefined) return undefined;

        const stations = await fetch(lookup)
          .then(res => res.json())
          .then(data => console.log('Stations: %o', data) || data.features)
          .catch(err => console.error(err) || error400());
        if (stations === undefined) return undefined;

        const station = stations[0];
        const gcs1 = new GCS(latitude, longitude),
              gcs2 = new GCS(...station.geometry.coordinates.reverse());

        console.log('Closest station: %o', `${station.properties.name} [${station.properties.stationIdentifier}] (${gcs1.distance(gcs2).toFixed(2)} km)`);
        return callback(`${station.id}/observations/latest`);
      }

      if (sessionStorage.getItem('location')) {
        const { latitude, longitude } = JSON.parse(sessionStorage.getItem('location'));
        success({ coords: { latitude, longitude } });
      } else navigator.geolocation.getCurrentPosition(success, console.error);
      return promise;
    } else return undefined;
  })(),
  init: (async function() {
    return await fetch(utility.getApiPath('govee', 'devices'), { method: 'GET' })
      .then(res => res.json())
      .then(({ data }) => {
        console.log('Initialization: %o', data);
        output.innerText = JSON.stringify(data, null, 2);

        return data;
      })
      .catch(err => console.error(err) || error400());
  })(),
}, database = {};

for (const [ k, promise ] of Object.entries(promises))
  promise.then(data => console.log(`Promise "${k}" resolved with: %o`, data) || (database[k] = data));
await Promise.all(Object.values(promises));

async function updateCall(updatePromises, dev_mode = false) {
  let device;
  if ('index' in config.device.use) device = database.init.devices[config.device.use.index]; // get specific device
  else if ('sku' in config.device.use && 'mac_address' in config.device.use)
    device = database.init.devices.find(d => d.sku === config.device.use.sku && d.device === config.device.use.mac_address); // get specific device
  device ??= database.init.devices[0]; // default to first device

  const date = new Date(); // get current time
  {
    const offset = date.valueOf() - testTime.init;
    const time = testTime.time + offset;
    date.setHours(time / 3600000 | 0, time / 60000 % 60 | 0, time / 1000 % 60 | 0, time % 1000);
  }

  const { phase, progress, sources } = await getPhase(date); // get current phase and progress
  if (phase === undefined) return; // skip if phase is undefined
  else if (phase.id !== memory.sceneChange.phase) memory.sceneChange = { phase: phase.id, time: 0, scene: null }; // reset scene change if phase changes


  const display = getDisplayAccessor(phase), // get display accessor
        scenes = display('scenes'); // get scenes

  if (scenes) { // scene change
    if (memory.sceneChange.time === null || date < memory.sceneChange.time) return; // skip if scene change is not ready

    const scene = scenes.weightedRandom(scenes.map(s => s.weight ?? 1)), // get random scene based on weight
          deviceScene = utility.findScene(device, scene.name); // find scene in device capabilities

    if (deviceScene === undefined) return console.error('Scene %o not found in device capabilities', scene.name);

    let end;
    if ('duration' in scene && 'min' in scene.duration && 'max' in scene.duration) {
      const t = new Time(date),
            tMn = +t.add(scene.duration.min),
            tMx = +t.add(scene.duration.max);

      end = new Date(Number.standardize(Math.random(), tMn, tMx));
    }

    if (memory.sceneChange.scene !== scene.name)
      await fetch(utility.getApiPath('govee', 'controller'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: device.sku, device: device.device,
          capabilities: [ { path: '/device/control', type: deviceScene.cap.type, instance: deviceScene.cap.instance, value: deviceScene.scene.value } ],
          dev_mode,
        }),
      })
        .then(res => res.json())
        .then(data => {
          memory.timer = new Date(data.countdown);

          memory.sceneChange.scene = scene.name;
          if (end) {
            console.log(`${new Date().toLocaleString()}: %o scene duration`, Time.toText(end - date));
            memory.sceneChange.time = end;
          }
        })
        .catch(err => {
          memory.timer = new Date();
          console.error(err);
        });
    return;
  } else {
    memory.sceneChange.scene = null;
    memory.sceneChange.time = 0;
    switch (phase.id_display) {
      case 'sunlight > daytime':
      case 'sunlight > sunset': {
        const data = {
          segment: utility.findCapability(device, 'segment_color_setting', 'segmentedColorRgb').parameters.fields.find(f => f.fieldName === 'segment'),
          rgb: utility.findCapability(device, 'segment_color_setting', 'segmentedColorRgb').parameters.fields.find(f => f.fieldName === 'rgb'),
          brightness: utility.findCapability(device, 'segment_color_setting', 'segmentedBrightness').parameters.fields.find(f => f.fieldName === 'brightness'),
        };

        const segments = Array.from({ length: data.segment.elementRange.max - data.segment.elementRange.min }).map(() => ({}));
        { // outside temperature segment control
          { // color temperature
            const deviceRange = data.rgb.range;
            if (deviceRange) {
              const configRange = config.source.weather.temperature;
              const normal = Number.normalize(sources.weather.temperature.value, configRange.min, configRange.max);

              const constantRange = constant.script.temperature_to_rgb.temperature;
              const standard = Number.standardize(1 - normal, constantRange.min, constantRange.max);

              const rgb = new RGB({ temp: standard }).number;
              config.device.segment.clockwise.bottom.forEach(i => segments[i].rgb = rgb);
            }
          }

          { // visibility
            const deviceRange = data.brightness.range;
            if (deviceRange) {
              const configRange = config.source.weather.visibility;
              const normal = Number.normalize(sources.weather.visibility.value, configRange.min, configRange.max);

              const brightness = Number.standardize(normal, deviceRange.min, deviceRange.max, deviceRange.precision);
              config.device.segment.clockwise.bottom.forEach(i => segments[i].brightness = brightness);
            }
          }
        }

        if ('moonlight' in progress) { // moonlight segment control
          const segment = (function(pos, i) {
            const list = [ ...pos.left, ...pos.top, ...pos.right ];
            return segments[list[i * list.length | 0]];
          })(config.device.segment.clockwise, progress.moonlight);

          const frac = Number.normalize(+sources.luminary.properties.data.fracillum.replace(/\D/g, ''), 0, 100);
          segment.brightness = Number.standardize(frac, data.brightness.range.min, data.brightness.range.max, data.brightness.range.precision);
          segment.rgb = new RGB(display('color', 'moon')).number;
        }

        if ('daytime > sunlight' in progress) { // sun segment control
          const segment = (function(pos, i) {
            const list = [ ...pos.left, ...pos.top, ...pos.right ];
            return segments[list[i * list.length | 0]];
          })(config.device.segment.clockwise, progress['daytime > sunlight']);

          segment.brightness = data.brightness.range.max;
          segment.rgb = new RGB(display('color', 'sun')).number;
        }

        { // cloud segment control
          const clouds = utility.getCloudData(sources.weather.cloudLayers);
          const clearMinMax = clouds
            .map(a => [ 1 - a.range.min, 1 - a.range.max ])
            .reduce((p, n) => [ p[0] * n[0], p[1] * n[1] ], [ 1, 1 ]);

          for (const segment of segments) {
            if (segment.rgb === undefined) {
              let rgb, brightness;

              const clear = Number.standardize(Math.random(), ...clearMinMax);
              if (Math.random() < clear) { // clear sky segment
                rgb = new RGB(display('color', 'sky'));
                brightness = 'sunset' in progress ? 1 - (progress.sunset * 0.9) : 1;
              } else { // cloud segment
                rgb = new RGB(display('color', 'cloud'));

                const pm = Number.standardize(Math.random(), -0.1, 0.1);
                brightness = Number.standardize(1 - clear + pm, 0.7, 0.9);
              }

              segment.rgb = rgb.number;
              segment.brightness = Number.standardize(brightness, data.brightness.range.min, data.brightness.range.max, data.brightness.range.precision);
            }
          }
        }

        const max = data.segment.size.max,
              template = { path: '/device/control', type: 'devices.capabilities.segment_color_setting', instance: null, value: { segment: [] } },
              capabilities = segments.reduce((caps, seg, i) => {
                const add = k => {
                  const cap = caps.find(c => c.value[k] === seg[k]);
                  if (cap && cap.value.segment.length < max) cap.value.segment.push(i);
                  else {
                    const newCap = JSON.parse(JSON.stringify(template));
                    newCap.instance = k === 'rgb' ? 'segmentedColorRgb' : 'segmentedBrightness';

                    newCap.value.segment.push(i);
                    newCap.value[k] = seg[k];

                    return caps.push(newCap);
                  }
                };

                add('rgb'), add('brightness');
                return caps;
              }, []);

        if (capabilities.length)
          await fetch(utility.getApiPath('govee', 'controller'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sku: device.sku, device: device.device, capabilities, process: 'sequential', dev_mode }),
          })
            .then(response => response.json())
            .then(data => { memory.timer = new Date(data.countdown); })
            .catch(err => {
              console.error(err);
              memory.timer = new Date();
            });
        return;
      } break;
    }
  }

  return undefined;
}

async function update(dev_mode = false) {
  if (memory.updateTimer === null) return console.warn('Skipping update due to existing update timer');
  memory.updateTimer = null;

  const updatePromises = [];
  await updateCall(updatePromises, dev_mode);

  await Promise.allSettled(updatePromises);

  const countdown = Math.max(memory.timer - Date.now(), 3000); // minimum of 3000ms delay to not overwork CPU and server
  memory.timer = new Date(Date.now() + countdown);
  memory.updateTimer = setTimeout(update, countdown);
}
memory.updateTimer = setTimeout(update, memory.timer - Date.now());

async function getSchoolData() {
  const date = new Date();
  const d = date.getDay(), m = date.getMonth() + 1;
  if (d === 0 || d === 6 || m === 7) return false; // Saturday, Sunday, or July

  const fetcher = async path => fetch(utility.getApiPath('hcpss', path), { method: 'GET' })
    .then(res => res.text())
    .then(html => new DOMParser().parseFromString(html, 'text/html'));

  const promises = {
    calendar: fetcher('calendar')
      .then(doc => !doc.querySelector('table.calendar > tbody > tr > td.active').classList.contains('closed-day'))
      .catch(err => console.error(err) || true), // assume normal operating day
    code: fetcher('status')
      .then(doc => {
        const status = doc.querySelector('section#status-block > div > h2 > span.status-date + span');
        for (const code of constant.api.hcpss.status_code)
          if (new RegExp(code.pattern, 'i').test(status.textContent))
            return code.closure ? false : +code.delay || true; // schools closed or delayed opening (with fallback to normal operating day)
        return true; // assume normal operating day
      })
      .catch(err => console.error(err) || true), // assume normal operating day
  };

  const fulfilled = await Promise.allSettled(Object.values(promises)),
        statuses = Object.fromEntries(Object.keys(promises).map((k, i) => [ k, fulfilled[i].value ]));

  let status = statuses.calendar && statuses.code; // schools closed, delayed opening, or normal operating day
  if (status === false) return null; // schools closed
  else if (status === true) status = '+0'; // normal operating day

  return new Time(config.source.hcpss.start.time).add(config.source.hcpss.start.offset, status).toDate(date); // return start time
}

async function getLuminaryData(date = new Date()) {
  const { latitude, longitude } = JSON.parse(sessionStorage.getItem('location'));

  const params = new URLSearchParams({ date: date.toISOString().split('T')[0], coords: `${latitude},${longitude}`, tz: date.getTimezoneOffset() / -60});
  const data = await fetch(`${constant.api.luminary.location}?${params}`)
    .then(res => res.json())
    .catch(err => console.error(err));

  const get = (function(type) {
    const data = this.data.properties.data[`${type}data`],
          conditions = config.source.luminary[type];

    const check = (o, k, phen, t, con) => {
      if (con.phenomenon === phen)
        o[k] = t.add(con.offset).toDate(date);
    };

    const rtn = { rise: {}, set: {} };
    for (let { phen, time } of data) {
      time = new Time(time);
      check(rtn.rise, 'start', phen, time, conditions.rise.start); check(rtn.rise, 'end', phen, time, conditions.rise.end);
      check(rtn.set, 'start', phen, time, conditions.set.start); check(rtn.set, 'end', phen, time, conditions.set.end);
    }
    return rtn;
  }).bind({ data });

  return { sun: get('sun'), moon: get('moon'), properties: data.properties };
}

async function getWeatherData() {
  return await fetch(database.station)
    .then(r => r.json())
    .then(v => v.properties)
    .catch(err => console.error(err));
}

async function getPhase(date = new Date()) {
  const promises = {
    school: getSchoolData(),
    luminary: getLuminaryData(date),
    weather: getWeatherData(),
  };

  const sources = await Promise.all(Object.values(promises))
    .then(data => Object.fromEntries(Object.keys(promises).map((k, i) => [ k, data[i] ])))
    .catch(err => console.error(err));
  if (sources === undefined) return undefined;

  const progress = {};
  const checkCondition = (function(group, con) {
    const id = group + (con.name ? ` > ${con.name}` : '');
    if ('time' in con) {
      let { start, end } = con.time;
      start = this.var.time[start] ?? new Time(start).toDate();
      end = this.var.time[end] ?? new Time(end).toDate();

      if (start > end && !(date >= start || date < end)) return false;
      else if (start <= end && !(date >= start && date < end)) return false;

      const percent = start <= end ?
        (date - start) / (end - start) :
        (date < start ? 1440 - start + date : date - start) / (1440 - start + end);

      progress[id] = percent;
    }

    if ('weather' in con) {
      if ('present' in con.weather && !this.var.weather.present.includes(con.weather.present))
        return false;
    }

    return true;
  }).bind({ var: {
    time: {
      "school.start": sources.school,

      "sunrise.start": sources.luminary.sun.rise.start, "sunrise.end": sources.luminary.sun.rise.end,
      "sunset.start": sources.luminary.sun.set.start, "sunset.end": sources.luminary.sun.set.end,

      "moonrise.start": sources.luminary.moon.rise.start, "moonrise.end": sources.luminary.moon.rise.end,
      "moonset.start": sources.luminary.moon.set.start, "moonset.end": sources.luminary.moon.set.end,
    },
    weather: {
      present: sources.weather.presentWeather.map(ev => ev.weather),
    },
  }, });

  const phase = config.device.phase
    .map((phase, i) => {
      let valid = false;
      for (let j = 0; j < phase.conditions.length; j++) {
        const con = checkCondition(phase.group, phase.conditions[j]) && j;
        if (valid === false) valid = con; // index of first valid condition
      }

      if (phase.display === undefined || !(phase.display in config.device.display)) return undefined;
      else if (valid === false) return undefined;

      const con = phase.conditions[valid];
      return {
        id: phase.group + (con.name ? ` > ${con.name}` : ''),
        id_display: phase.display + (con.sub_display ? ` > ${con.sub_display}` : ''),

        group: phase.group, display: phase.display,
        name: con.name, sub_display: con.sub_display,
        priority: con.priority ?? phase.priority, index: i,
      };
    })
    .filter(p => p !== undefined)
    .sort((a, b) => (b.priority - a.priority) || (a.index - b.index))[0]; // sort by priority (descending) then index (ascending)

  window.output = { phase: phase.id, display: phase.id_display };
  return { phase, progress, sources };
}

function getDisplayAccessor(phase) {
  const { display, sub_display } = phase;

  const root = config.device.display[display].root ?? {},
        sub = config.device.display[display].sub?.[sub_display] ?? {};

  return (function(...ks) { return Object.safeGet(this.sub, ...ks) ?? Object.safeGet(this.root, ...ks); }).bind({ root, sub });
}

async function timer() {
  DisplayNumber(memory.timer - Date.now());
  requestAnimationFrame(timer);
}
timer();

window.addEventListener('keyup', function(event) {
  if (event.key === 'Enter' && event.ctrlKey) {
    clearTimeout(memory.updateTimer);
    update(true);
  }
});