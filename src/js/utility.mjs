const createUuid = () => {
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
  return `${s4() + s4()}-${s4()}-${s4()}-${s4()}-${s4() + s4() + s4()}`;
};

const weightedRandom = ws => {
  const Σw = ws.reduce((a, b) => a + b, 0);
  let r = Math.random() * Σw, i = 0;
  while (r >= 0) r -= ws[i++];
  return i - 1;
};

const _proto_ = Object.freeze({
  'Array.prototype': [ Array.prototype, {
    last: { get () { return this[this.length - 1]; } },

    shuffle: { value () { return this.sort(() => Math.random() - 0.5); } },
    weightedRandom: { value (ws) { return this[weightedRandom(ws)]; } },
  } ],
  Number: [ Number, {
    clamp: { value (n, mn = Number.NEGATIVE_INFINITY, mx = Number.POSITIVE_INFINITY) { return Math.min(Math.max(n, mn), mx); } },
    normalize: { value (n, mn, mx) { return Math.min(Math.max((n - mn) / (mx - mn), mn), mx); } },
    standardize: { value (n, mn, mx, pr = null) {
      n = Math.min(Math.max(n, 0), 1) * (mx - mn) + mn;
      if (pr === null) return n;
      else return Math.round(n * pr) / pr;
    } },
  } ],
  Object: [ Object, {
    getLast: { value (o, k) {
      const v = o[k];
      delete o[k];
      return v;
    } },

    safeGet: { value (o, ...ks) {
      if (o === undefined || o === null) return undefined;
      for (const k of ks)
        if (k in o) o = o[k];
        else return undefined;
      return o;
    } },
    safeSet: { value (o, ...args) {
      const [ K, v ] = args.splice(-2);
      for (const k of args)
        if (k in o) o = o[k];
        else o = o[k] = {};
      return o[K] = v;
    } },
  } ],
});

const Time = Object.freeze({
  from: {
    string (str) {
      const rel = str.startsWith('+') ? 1 : (str.startsWith('-') ? -1 : 0);
      let [ hr = 0, min = 0, sec = 0, ms = 0 ] = str.split(':').map(ch => +ch.replace(/[^0-9]/g, ''));
      (min %= 60), (sec %= 60), (ms %= 1000); // normalize

      let t = (((hr * 60) + min) * 60 + sec) * 1000 + ms; // in milliseconds
      if (rel) t *= rel;

      return { rel: !!rel, time: t };
    },
    Date (d = new Date()) {
      const d2 = new Date(d); d2.setHours(0, 0, 0, 0);
      return { rel: false, time: d.getTime() - d2.getTime() };
    },
  },
  to: {
    Date (o, d = new Date()) {
      if (o.rel) return new Date(d.getTime() + o.time);

      const d2 = new Date(d); d2.setHours(0, 0, 0, 0);
      return new Date(d2.getTime() + o.time);
    },
  },
  calc: {
    add (o1, ...os) {
      const rtn = { rel: o1.rel, time: o1.time };
      for (const o of os)
        if (o?.rel) rtn.time += o.time;
        else return undefined;
      return rtn;
    },
  },
});

const Angle = Object.freeze({
  to: {
    rad (deg) { return deg * Math.PI / 180; },
    deg (rad) { return rad * 180 / Math.PI; },
  }
});

const Coord = Object.freeze({
  calc: {
    dist (lat1, lon1, lat2, lon2) { // Haversine formula
      const φ1 = Angle.to.rad(lat1),
            φ2 = Angle.to.rad(lat2);

      const Δφ = Angle.to.rad(lat2 - lat1),
            Δλ = Angle.to.rad(lon2 - lon1);

      const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                Math.cos(φ1) * Math.cos(φ2) *
                Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return 6371e3 * c; // in meters
    },
  }
});

const RGB = Object.freeze({
  from: {
    temp (temp) {
      temp /= 100;
      let r = temp <= 66 ?
        255 :
        329.698727446 * Math.pow(temp - 60, -0.1332047592);

      let g = temp <= 66 ?
        99.4708025861 * Math.log(temp) - 161.1195681661 :
        288.1221695283 * Math.pow(temp - 60, -0.0755148492);

      let b = temp >= 66 ?
        255 :
        temp <= 19 ?
          0 :
          138.5177312231 * Math.log(temp - 10) - 305.0447927307;

      (r = _proto_.Number[1].clamp.value(r, 0, 255)), (g = _proto_.Number[1].clamp.value(g, 0, 255)), (b = _proto_.Number[1].clamp.value(b, 0, 255));
      return { r, g, b };
    },
  },
  to: {
    color ({ r, g, b }) { return ((r & 0xff) << 16) + ((g & 0xff) << 8) + (b & 0xff); },
  },
});

const util_app = Object.freeze({
  readDataFile (fs, name, path, clientData, en = 'utf-8') {
    const o = JSON.parse(fs.readFileSync(path, en)),
          client = _proto_.Object[1].getLast.value(o, 'SECURE') ? null : _proto_.Object[1].getLast.value(o, 'send_to_client');

    const q = [ [ o, [] ] ];
    while (q.length) {
      const [ o, ks ] = q.shift();
      for (const [ k, v ] of Object.entries(o)) {
        const ks2 = [ ...ks, k ];
        if (_proto_.Object[1].safeGet.value(client, ...ks2) === true)
          _proto_.Object[1].safeSet.value(clientData, name, ...ks2, v);
        else if (v instanceof Object) q.push([ v, ks2 ]);
      }
    }
    return o;
  },

  createUuid () { return createUuid(); },
  createGoveeBody (device, cap) {
    const body = {
      requestId: createUuid(),
      payload: {
        sku: device.sku,
        device: device.device,
        capability: { type: cap.type, instance: cap.instance, value: cap.value },
      }
    };
    return JSON.stringify(body);
  }
});

const util_client = Object.freeze({
  findScene (device, name) {
    const cap1 = util.findCapability(device, 'dynamic_scene', 'lightScene');
    if (cap1) {
      const scene = cap1.parameters.options.find(opt => opt.name === name);
      if (scene) return { cap: cap1, scene };
    }

    const cap2 = util.findCapability(device, 'dynamic_scene', 'diyScene');
    if (cap2) {
      const scene = cap2.parameters.options.find(opt => opt.name === name);
      if (scene) return { cap: cap2, scene };
    }

    return null;
  },
  getCloudData (con, clouds) {
    const search = code => con.api.weather.cloud.coverage.find(cov => cov.codes.includes(code));
    return clouds.map(cloud => search(cloud.amount));
  },
});

const util = Object.freeze({
  createElement (tag, className, txt) {
    const el = document.createElement(tag);
    el.classList.add(...(Array.isArray(className) ? className : [ className ]));

    if (txt !== undefined) el.innerText = txt;
    return el;
  },
  createObject (...ks) { return Object.fromEntries(ks.map(k => [ k, null ])); },

  findCapability (device, type, inst) {
    const prefix = `devices.capabilities.`;
    if (!type.startsWith(prefix)) type = prefix + type;

    return device.capabilities.find(cap => cap?.type === type && cap?.instance === inst);
  },
  findCapabilityIndex (device, type, inst) {
    const prefix = `devices.capabilities.`;
    if (!type.startsWith(prefix)) type = prefix + type;

    return device.capabilities.findIndex(cap => cap?.type === type && cap?.instance === inst);
  },

  getApiPath (cfg, ...ks) {
    let root = cfg.api, rtn = root.path;
    for (const k of ks) {
      root = k in root ? root[k] : {};
      rtn += root.path;
    }
    return rtn;
  },

  weightedRandom (ws) { return weightedRandom(ws); },
});

const proto = Object.freeze({
  import: (function (...protos) {
    for (const name of protos)
      if (name in this.protos) Object.defineProperties(...this.protos[name]);
  }).bind({ protos: _proto_ }),
});

export { Time, Angle, Coord, RGB, util_app, util_client, util, proto };