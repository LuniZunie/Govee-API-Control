const CONFIG = {
  temperature: { min: -20, max: 40 }, // temperature range in celsius [-20, 40], ([-4, 104] in fahrenheit)
  visibility: { min: 0, max: 32186.9 }, // visibility range in meters [0, 32186.9], ([0, 20] in miles)
  clouds: {
    codes: [
      // code, name, coverage
      [ [ 'SKC', 'CLR' ], 'clear', [ 0/8, 0/8 ] ],
      [ [ 'FEW' ], 'few', [ 1/8, 2/8 ] ],
      [ [ 'SCT' ], 'scattered', [ 3/8, 4/8 ] ],
      [ [ 'BKN' ], 'broken', [ 5/8, 7/8 ] ],
      [ [ 'OVC', 'VV' ], 'overcast', [ 8/8, 8/8 ] ],
    ],
  },

  hosts: { proxy: 'http://localhost:3000/proxy', weather: 'https://api.weather.gov' }
};

const util = Object.freeze({
  request: async function(method, path, body, res, rej = console.error) {
    return await fetch(CONFIG.hosts.proxy + path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' && body ? JSON.stringify(body) : undefined,
    })
      .then(response => response.json()).then(data => res(data))
      .catch(error => rej(error));
  },

  deg2rad: d => d * (Math.PI / 180), rad2deg: r => r * (180 / Math.PI),

  coordDist: function(lat1, lon1, lat2, lon2) { // Haversine formula
    const φ1 = util.deg2rad(lat1), φ2 = util.deg2rad(lat2); // angle in radians of latitudes
    const Δφ = util.deg2rad(lat2 - lat1), Δλ = util.deg2rad(lon2 - lon1); // difference in latitudes and longitudes in radians

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2); // apply Haversine formula
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); // angular distance in radians

    return c * 6371; // distance in km (6371 is the radius of Earth in km)
  },

  client: document.getElementById('output'),
});

const promises = {
  station: (async function() {
    if (navigator.geolocation) {
      let callback;
      const promise = new Promise(res => callback = res);
      navigator.geolocation.getCurrentPosition(async function success(position) {
        const { latitude, longitude } = position.coords;

        const lookup = await fetch(`${CONFIG.hosts.weather}/points/${latitude},${longitude}`)
          .then(response => response.json()).then(data => console.log('Point: %o', data) || data.properties.observationStations)
          .catch(error => console.error(error));
        if (lookup === undefined) return undefined;

        const stations = await fetch(lookup)
          .then(response => response.json()).then(data => console.log('Stations: %o', data) || data.features)
          .catch(error => console.error(error));
        if (stations === undefined) return undefined;

        const byAscDist = stations.map(station => { // should already be sorted by distance, but I don't trust the government to do anything right
          const [ sLon, sLat ] = station.geometry.coordinates; // lon then lat for some reason ???
          return { station, Δ: util.coordDist(latitude, longitude, sLat, sLon) }; // distance in km
        }).sort((a, b) => a.Δ - b.Δ); // sort by distance
        console.log('Stations by closest distance: %o', byAscDist);

        console.log('Closest station: %o', `${byAscDist[0].station.properties.name} [${byAscDist[0].station.properties.stationIdentifier}] (${byAscDist[0].Δ.toFixed(2)} km)`);
        return callback(`${byAscDist[0].station.id}/observations/latest`);
      });

      return await promise;
    } else return undefined;
  })(),
  init: (async function() {
    return await util.request('GET', '/init', null, function(data) {
      console.log('Initialization: %o', data);
      util.client.innerText = JSON.stringify(data, null, 2);

      return data;
    });
  })(),
}, dat = { init: null, station: null };

for (const [ key, promise ] of Object.entries(promises))
  promise.then(data => console.log(`Promise "${key}" resolved with: %o`, data) || (dat[key] = data));
await Promise.all(Object.values(promises));

const mem = { temperature: null, brightness: null, scene: null };
async function call() {
  const device = dat.init.devices[0]; // get first device

  const observed = await fetch(dat.station)
    .then(response => response.json()).then(data => data.properties)
    .catch(error => console.error(error));
  if (observed === undefined) return;

  const { temperature: { value: tempRAW }, visibility: { value: visRAW }, cloudLayers: cloudsRAW, presentWeather: weatherRAW } = observed; // get raw relevant readings

  const weatherMAIN = weatherRAW.filter(weather => [ 'rain', 'thunderstorms' ].includes(weather.weather)); // get main weather
  if (weatherRAW.length) {
    (mem.temperature = null), (mem.brightness = null); // reset temperature and brightness

    const scene = (function(weather) {
      switch (weather) {
        case 'rain': return 'Downpour';
        case 'thunderstorms': return 'Lightning';
        default: // should never happen
          console.error('Unknown weather: %o', weather);
          debugger;
          return 'Rainbow';
      }
    })(weatherMAIN[0].weather);

    let instance = 'lightScene', value = dat.init.scenes.dynamic[device.sku][device.device].parameters.options.find(o => o.name === scene)?.value;
    if (value === undefined) instance = 'diyScene', value = dat.init.scenes.DIY[device.sku][device.device].parameters.options.find(o => o.name === scene)?.value;

    if (!(value === undefined || Object.is(mem.scene, value))) {
      let callback;
      const promise = new Promise(res => callback = res);
      util.request('POST', '/device/control', {
        'requestId': self.crypto.randomUUID(),
        'payload': {
          'sku': device.sku,
          'device': device.device,
          'capability': {
            'type': 'devices.capabilities.dynamic_scene',
            'instance': instance,
            'value': value,
          }
        },
      }, () => { mem.scene = value; callback(); }, err => { console.error(err) || callback(); });
      await Promise.all([ promise, new Promise(res => setTimeout(res, dat.init.rateLimit)) ]);
    }
  } else {
    mem.scene = null; // reset scene

    const tempRNG = device.capabilities.find(cap => cap.instance === 'colorTemperatureK').parameters.range; // get temperature range
    const tempNORM = (tempRAW - CONFIG.temperature.min) / (CONFIG.temperature.max - CONFIG.temperature.min); // normalize temperature
    const temp = Math.round((tempNORM * (tempRNG.max - tempRNG.min) + tempRNG.min) * tempRNG.precision) / tempRNG.precision; // calculate temperature in kelvin
    if (mem.temperature !== temp) {
      let callback;
      const promise = new Promise(res => callback = res);
      util.request('POST', '/device/control', {
        'requestId': self.crypto.randomUUID(),
        'payload': {
          'sku': device.sku,
          'device': device.device,
          'capability': {
            'type': 'devices.capabilities.color_setting',
            'instance': 'colorTemperatureK',
            'value': temp,
          }
        },
      }, () => { mem.temperature = temp; callback(); }, err => { console.error(err) || callback(); });
      await Promise.all([ promise, new Promise(res => setTimeout(res, dat.init.rateLimit)) ]);
    }

    const visRNG = device.capabilities.find(cap => cap.instance === 'brightness').parameters.range; // get visibility range
    const visNORM = (visRAW - CONFIG.visibility.min) / (CONFIG.visibility.max - CONFIG.visibility.min); // normalize visibility
    const vis = Math.round((visNORM * (visRNG.max - visRNG.min) + visRNG.min) * visRNG.precision) / visRNG.precision; // calculate visibility in meters
    if (mem.brightness !== vis) {
      let callback;
      const promise = new Promise(res => callback = res);
      util.request('POST', '/device/control', {
        'requestId': self.crypto.randomUUID(),
        'payload': {
          'sku': device.sku,
          'device': device.device,
          'capability': {
            'type': 'devices.capabilities.range',
            'instance': 'brightness',
            'value': vis,
          }
        },
      }, () => { mem.brightness = vis; callback(); }, err => { console.error(err) || callback(); });
      await Promise.all([ promise, new Promise(res => setTimeout(res, dat.init.rateLimit)) ]);
    }
  }

  requestAnimationFrame(call);
}
setTimeout(call, dat.init.rateLimit);