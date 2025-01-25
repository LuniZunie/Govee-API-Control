import fs from 'fs';

import fetch from 'node-fetch'; import express from 'express';
import cors from 'cors'; import bodyParser from 'body-parser';

const sendToClient = {};
function read(name, path, keepSecure = false, en = 'utf8') {
  const o = JSON.parse(fs.readFileSync(path, en));

  const set = (parent, child, path) => {
    let o = parent;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (o[k] === undefined) o[k] = {};
      o = o[k];
    }

    o[path[path.length - 1]] = child;
  }

  const get = (o, path) => {
    for (const k of path) {
      if (k in o) o = o[k];
      else return undefined;
    }
    return o;
  }

  const forClient = keepSecure ? {} : (o.for_client ?? {});
  if (o.for_client) delete o.for_client;

  const q = [ { obj: o, path: [] } ];
  for (let i = 0; i < q.length; i++) {
    const { obj, path } = q[i];
    for (const [ k, v ] of Object.entries(obj)) {
      const thisPath = [ ...path, k ];
      if (get(forClient, thisPath) === true) set(sendToClient, v, [ name, ...thisPath ]);
      else if (v instanceof Object) q.push({ obj: v, path: thisPath });
    }
  }

  return o;
}

const constant = read('constant', 'data/constant.json');
const config = read('config', constant.file.map.config), secret = read('secret', constant.file.map.secret, true);

const precision = config.api.throttle.time_precision;
const rateLimit = { end: -1, time: Math.round((86400000 / config.api.throttle.quota + precision / 2) / precision) * precision };

async function getDevices() {
  return await fetch(`${constant.api.govee.location}/user/devices`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', 'Govee-API-Key': secret.govee.api_key },
  })
    .then(r => r.json()).then(data => data.data)
    .catch(err => ({ error: err.message }));
}

async function getData(sku, device, path) {
  return await fetch(`${constant.api.govee.location}/device/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Govee-API-Key': secret.govee.api_key },
    body: JSON.stringify({ requestId: 'uuid', payload: { sku, device } }),
  })
    .then(r => r.json()).then(data => data.payload.capabilities)
    .catch(err => ({ error: err.message }));
}

let init = {};
async function INIT() {
  const devices = await getDevices(); if (devices.error) return console.error(devices.error) || false;
  init = { devices, states: [], lookup: {} };
  for (let i = 0; i < devices.length; i++) {
    const device = devices[i];
    const { sku, device: macAddr } = device ?? {}; if (sku === undefined || macAddr === undefined) return console.error('Invalid device') || false;

    if (init.lookup[sku] === undefined) init.lookup[sku] = { [macAddr]: i };
    else init.lookup[sku][macAddr] = i;

    const find = { 'devices.capabilities.dynamic_scene lightScene': false, 'devices.capabilities.dynamic_scene diyScene': false };
    for (let j = 0; j < device.capabilities.length; j++) {
      const capability = device.capabilities[j];
      const { type, instance } = capability ?? {}; if (type === undefined || instance === undefined) continue;

      const k = `${type} ${instance}`;
      if (find[k] === false) {
        find[k] = j;
        if (Object.values(find).every(v => v !== false)) break;
      }
    }

    if (find['devices.capabilities.dynamic_scene lightScene'] !== false) {
      const lightScene = await getData(sku, macAddr, 'scenes'); if (lightScene.error) return console.error(lightScene.error) || false;
      device.capabilities[find['devices.capabilities.dynamic_scene lightScene']] = lightScene[0];
    }

    if (find['devices.capabilities.dynamic_scene diyScene']) {
      const diyScene = await getData(sku, macAddr, 'diy-scenes'); if (diyScene.error) return console.error(diyScene.error) || false;
      device.capabilities[find['devices.capabilities.dynamic_scene diyScene']] = diyScene[0];
    }

    const state = await getData(sku, macAddr, 'state'); if (state.error) return console.error(state.error) || false;
    init.states.push(state);
  }

  return true;
}
await INIT();

function getCountdown() {
  return Math.max(rateLimit.end - Date.now(), 0);
}

function format(data, flatten = false) {
  if (flatten) return { ...data, countdown: getCountdown() };
  else return { data, countdown: getCountdown() };
}

const app = express();
app.use(cors()); app.use(bodyParser.json());

app.set('view engine', 'ejs');
app.use(express.static('script'));

app.get('/', (req, res) => {
  res.render('index', { json: JSON.stringify(format(sendToClient)) });
});

app.use(config.api.path + config.api.govee.path, async (req, res) => {
  const { method, path, body } = req; if (!config.api.govee.methods.includes(method)) return res.status(400).json(format({ error: 'Invalid method' }, 1));

  switch (path) { // non-rate limited calls
    case config.api.govee.map.devices.path: return res.status(200).json(format(init));
    default: { // rate limiter
      if (getCountdown() > 0) return res.status(429).json(format({ error: 'Rate limited' }, 1));
    } break;
  }

  switch (path) { // rate limited calls
    case config.api.govee.map.refresh_devices.path: {
      if (await INIT()) return res.status(200).json(format(init));
      return res.status(500).json(format({ error: 'Failed to re-initialize' }, 1));
    } break;
    case config.api.govee.map.controller.path: {
      const { sku, device: macAddr, capabilities } = body ?? {}; if (sku === undefined || macAddr === undefined || !Array.isArray(capabilities)) return res.status(400).json(format({ error: 'Invalid body' }, 1));
      const process = (body ?? {}).process ?? 'parallel'; if (process !== 'parallel' && process !== 'sequential') return res.status(400).json(format({ error: 'Invalid process' }, 1));

      const capsObj = capabilities.reverse().reduce(([ mapped, existing ], cap) => {
        const id = `${cap.type} ${cap.instance}`;
        if (existing.has(id)) mapped.unshift({ cap, dup: true });
        else {
          existing.add(id);
          mapped.unshift({ cap, dup: false });
        }

        return [ mapped, existing ];
      }, [ [], new Set() ]); // later duplicate capabilities have priority as it should act as if there was no duplicate

      if (capsObj[1].size > config.api.throttle.controller_requests) return res.status(400).json(format({ error: 'Too many capabilities for one call' }, 1));
      const caps = capsObj[0];

      if (sku in init.lookup) {
        const index = init.lookup[sku][macAddr]; if (index === undefined) return res.status(400).json(format({ error: 'Invalid device' }, 1));

        let apiCalls = 0;
        const rtn = [], promises = [];
        for (let i = 0; i < caps.length; i++) {
          const setReturn = (function(o) { rtn[this] = o; }).bind(i);
          setReturn({ status: 0b000, message: 'pending' });

          const { dup, cap } = caps[i];
          if (dup) { setReturn({ status: 0b010, message: 'failure#duplicate', data: { error: 'Duplicated capability requested' } }); continue; }

          const { type, instance, value } = cap ?? {}; if (type === undefined || instance === undefined) return res.status(400).json(format({ error: 'Invalid capability' }, 1));
          const hasCap = init.devices[index].capabilities.some(test => cap.type === test.type && cap.instance === test.instance);
          if (!hasCap) { setReturn({ status: 0b100, message: 'failure#missing_capability', data: { error: 'Device does not have requested capability' } }); continue; }
          else apiCalls++;

          console.log(`\n${new Date().toLocaleString()}: Setting %o for %o to %o\nSKU: %o\nMAC_ADDRESS: %o\n`, instance, type, value, sku, macAddr);

          const promise = fetch(constant.api.govee.location + cap.path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Govee-API-Key': secret.govee.api_key },
            body: JSON.stringify({ requestId: 'uuid', payload: { sku, device: macAddr, capability: { type, instance, value } } }),
          })
            .then(r => r.json()).then(data => setReturn({ status: 0b001, message: 'success', data }))
            .catch(err => console.error(err) || setReturn({ status: 0b110, message: 'failure#fetch_error', data: err }));

          if (process === 'parallel') promises.push(promise); // execute all fetch requests ASAP
          else await promise; // wait for fetch request to finish before proceeding to next fetch request
        }

        if (process === 'parallel') await Promise.allSettled(promises); // wait for fetch requests to finish

        rateLimit.end = Date.now() + rateLimit.time * apiCalls;
        return res.status(200).json(format(rtn));
      } else return res.status(400).json(format({ error: 'Invalid SKU' }, 1));
    } break;
    default: return res.status(400).json(format({ error: 'Invalid path' }, 1));
  }
});

app.use(config.api.path + config.api.hcpss.path, async (req, res) => {
  const { method, path, body } = req; if (!config.api.hcpss.methods.includes(method)) return res.status(400).json(format({ error: 'Invalid method' }, 1));

  switch (path) {
    case config.api.hcpss.map.calendar.path: {
      fetch(constant.api.hcpss.calendar.location)
        .then(r => r.text()).then(txt => res.status(200).send(txt))
        .catch(err => console.error(err) || res.status(500).json(format({ error: err.message }, 1)));
    } break;
    case config.api.hcpss.map.status.path: {
      fetch(constant.api.hcpss.status.location)
        .then(r => r.text()).then(txt => res.status(200).send(txt))
        .catch(err => console.error(err) || res.status(500).json(format({ error: err.message }, 1)));
    } break;
    default: return res.status(400).json(format({ error: 'Invalid path' }, 1));
  }
});

app.listen(config.server.port, () => console.log(`Proxy server running at http://localhost:${config.server.port}`));