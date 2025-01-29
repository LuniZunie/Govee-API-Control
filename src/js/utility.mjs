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
  Math: [ Math, {
    weightedRandom: { value (ws) { return weightedRandom(ws); } },
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

class Time {
  #rel = false;
  #time;

  #parse = {
    Date: d => [ false, d.getTime() ],
    string (s) {
      const rel = { '+': 1, '-': -1 }[s[0]] || 0;
      let [ hr = 0, min = 0, sec = 0, ms = 0 ] = s.split(':').map(ch => +ch.replace(/[^0-9]/g, ''));
      (min %= 60), (sec %= 60), (ms %= 1000); // normalize

      let t = (((hr * 60) + min) * 60 + sec) * 1000 + ms; // in milliseconds
      if (rel) t *= rel; // ±

      return [ rel, t ];
    },
    number: t => [ false, t ],
  };

  static toText (t) {
    const sign = t < 0 ? '-' : ''; t = Math.abs(t);

    let ms = t % 1000; t = Math.floor(t / 1000);
    let sec = t % 60; t = Math.floor(t / 60);
    let min = t % 60; t = Math.floor(t / 60);
    let hr = t;

    const set = (n, s) => (n ? `${n}${s}` : '');

    return `${sign}${set(hr, 'hr ')}${set(min, 'min ')}${set(sec, 'sec ')}${set(ms, 'ms')}`;
  }

  constructor (t, rel) {
    if (t instanceof Time) t = [ t.#rel, t.#time ];
    else if (t instanceof Date) t = this.#parse.Date(t);
    else if (typeof t === 'string') t = this.#parse.string(t);
    else if (typeof t === 'number') t = this.#parse.number(t);
    else t = [ false, NaN ];

    this.#rel = Boolean(rel ?? t[0]);
    this.#time = +t[1];
  }

  get relative () { return this.#rel; }

  #add (Δts) {
    let t = this.#time;
    for (let Δt of Δts) {
      if (!(Δt instanceof Time))
        try { Δt = new Time(Δt); }
        catch { throw new Error('Invalid time format'); }

      if (Δt.#rel) t += Δt.#time;
      else throw new Error("Absolute time cannot be added");
    }
    return t;
  }

  addTo (...Δts) {
    const t = this.#add(Δts);
    return this.#time = t;
  }
  add (...Δts) {
    const t = this.#add(Δts);
    return new Time(t);
  }

  toDate (d = new Date()) {
    if (this.#rel) return new Date(d.getTime() + this.#time);

    const d2 = new Date(d); d2.setHours(0, 0, 0, 0);
    return new Date(d2.getTime() + this.#time);
  }

  [Symbol.toPrimitive](hint) {
    switch (hint) {
      default:
      case 'number': return this.#time;
      case 'string': {
        if (this.#rel) return (this.#time < 0 ? '-' : '+') + new Date(this.toDate()).toISOString();
        else return new Date(this.toDate()).toISOString();
      }
    }
  }
}

class Angle {
  static toRadians = def => def * Math.PI / 180;
  static toDegrees = rad => rad * 180 / Math.PI;
}

class GCS {
  #lat; #lon;
  constructor (lat, lon) {
    this.lat = lat;
    this.lon = lon;
  }

  get lat () { return this.#lat; }
  set lat (lat) {
    if (Number.isFinite(lat) && lat >= -90 && lat <= 90) this.#lat = lat;
    else throw new Error('Invalid latitude');
  }

  get lon () { return this.#lon; }
  set lon (lon) {
    if (Number.isFinite(lon) && lon >= -180 && lon <= 180) this.#lon = lon;
    else throw new Error('Invalid longitude');
  }

  distance (gcs) {
    if (!(gcs instanceof GCS)) throw new Error('Invalid GCS object');

    const φ1 = Angle.toRadians(this.lat),
          φ2 = Angle.toRadians(gcs.lat);
    const Δφ = Angle.toRadians(gcs.lat - this.lat),
          Δλ = Angle.toRadians(gcs.lon - this.lon);

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return 6371e3 * c; // in meters
  }
}

class RGB {
  #parse = {
    num: n => [ (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff ],
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
      return [ r, g, b ];
    },
    obj: (r, g, b) => [ _proto_.Number[1].clamp.value(r, 0, 255), _proto_.Number[1].clamp.value(g, 0, 255), _proto_.Number[1].clamp.value(b, 0, 255) ],
  };

  #r; #g; #b;
  constructor (rgb) {
    if (!(rgb instanceof Object)) throw new Error('Invalid RGB object');
    else if ('temperature' in rgb || 'temp' in rgb)
      rgb = this.#parse.temp(rgb.temperature ?? rgb.temp);
    else if ('number' in rgb || 'num' in rgb)
      rgb = this.#parse.num(rgb.number ?? rgb.num);
    else if (('red' in rgb || 'r' in rgb) && ('green' in rgb || 'g' in rgb) && ('blue' in rgb || 'b' in rgb))
      rgb = this.#parse.obj(rgb.red ?? rgb.r, rgb.green ?? rgb.g, rgb.blue ?? rgb.b);

    [ this.#r, this.#g, this.#b ] = rgb;
  }

  get red () { return this.#r; }
  get green () { return this.#g; }
  get blue () { return this.#b; }
  get rgb () { return { r: this.#r, g: this.#g, b: this.#b }; }

  get number () { return (this.#r << 16) + (this.#g << 8) + this.#b; }
}

class Utility {
  #script = null;
  #config; #constant;
  constructor (script = '', cfg, con) {
    if (![ 'app', 'client', '' ].includes(script)) throw new Error('Invalid script type');
    this.#script = script;

    this.#config = cfg;
    this.#constant = con;
  }

  createElement (tag, className, txt) {
    const el = document.createElement(tag);
    el.classList.add(...(Array.isArray(className) ? className : [ className ]));

    if (txt !== undefined) el.innerText = txt;
    return el;
  }
  createObject (...ks) { return Object.fromEntries(ks.map(k => [ k, null ])); }

  findCapability (device, type, inst) {
    const prefix = `devices.capabilities.`;
    if (!type.startsWith(prefix)) type = prefix + type;

    return device.capabilities.find(cap => cap?.type === type && cap?.instance === inst);
  }
  findCapabilityIndex (device, type, inst) {
    const prefix = `devices.capabilities.`;
    if (!type.startsWith(prefix)) type = prefix + type;

    return device.capabilities.findIndex(cap => cap?.type === type && cap?.instance === inst);
  }

  getApiPath (...ks) {
    let root = this.#config.api, rtn = root.path;
    for (const k of ks) {
      root = k in root ? root[k] : {};
      rtn += root.path;
    }
    return rtn;
  }

  createUuid () { return createUuid(); }

  // app-specific
  readDataFile (fs, name, path, clientData, en = 'utf-8') {
    if (this.#script !== 'app') throw new Error('Method not available');

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
  }
  createGoveeBody (device, cap) {
    if (this.#script !== 'app') throw new Error('Method not available');

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

  // client-specific
  findScene (device, name) {
    if (this.#script !== 'client') throw new Error('Method not available');

    const cap1 = this.findCapability(device, 'dynamic_scene', 'lightScene');
    if (cap1) {
      const scene = cap1.parameters.options.find(opt => opt.name === name);
      if (scene) return { cap: cap1, scene };
    }

    const cap2 = this.findCapability(device, 'dynamic_scene', 'diyScene');
    if (cap2) {
      const scene = cap2.parameters.options.find(opt => opt.name === name);
      if (scene) return { cap: cap2, scene };
    }

    return null;
  }
  getCloudData (clouds) {
    if (this.#script !== 'client') throw new Error('Method not available');

    const search = code => this.#constant.api.weather.cloud.coverage.find(cov => cov.codes.includes(code));
    return clouds.map(cloud => search(cloud.amount));
  }
}

const proto = Object.freeze({
  import: (function (...protos) {
    for (const name of protos)
      if (name in this.protos) Object.defineProperties(...this.protos[name]);
  }).bind({ protos: _proto_ }),
});

export { Time, Angle, GCS, RGB, Utility, proto };