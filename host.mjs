import fs from 'fs';

import fetch from 'node-fetch'; import express from 'express';
import cors from 'cors'; import bodyParser from 'body-parser';

const read = (path, en = 'utf8') => JSON.parse(fs.readFileSync(path, en));

const CONFIG = read('data/config.json');
const DEFINE = read(CONFIG.pointer.define), SECRET = read(CONFIG.pointer.secret);

const precision = CONFIG.govee.rate_limit.precision;
const rateLimit = { end: -1, time: Math.round((86400000 / CONFIG.govee.rate_limit.quota + precision / 2) / precision) * precision };

async function getDevices() {
  return await fetch(`${CONFIG.govee.api}/user/devices`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', 'Govee-API-Key': SECRET.govee.api_key },
  })
    .then(r => r.json()).then(data => data.data)
    .catch(err => ({ error: err.message }));
}

async function getData(sku, device, path) {
  return await fetch(`${CONFIG.govee.api}/device/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Govee-API-Key': SECRET.govee.api_key },
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

app.use('/proxy', async (req, res) => {
  const { method, path, headers, body } = req; if (!CONFIG.server.proxy.methods.includes(method)) return res.status(400).json(format({ error: 'Invalid method' }, 1));

  switch (path) { // non-rate limited calls
    case '/init': return res.status(200).json(format(init));
    case '/data': return res.status(200).json(format({
      config: { max_stack: CONFIG.govee.rate_limit.max_stack, weather: CONFIG.weather },
      define: { weather: DEFINE.weather }
    }));
    default: { // rate limiter
      if (getCountdown() > 0) return res.status(429).json(format({ error: 'Rate limited' }, 1));
    } break;
  }

  switch (path) { // rate limited calls
    case '/re-init': {
      if (await INIT()) return res.status(200).json(format(init));
      return res.status(500).json(format({ error: 'Failed to re-initialize' }, 1));
    } break;
    case '/stack': {
      const { sku, device: macAddr, capabilities } = body ?? {}; if (sku === undefined || macAddr === undefined || !Array.isArray(capabilities)) return res.status(400).json(format({ error: 'Invalid body' }, 1));
      const process = (body ?? {}).process ?? 'parallel'; if (process !== 'parallel' && process !== 'sequential')

      const capsObj = capabilities.reverse().reduce(([ mapped, existing ], cap, i) => {
        const id = `${cap.type} ${cap.instance}`;
        if (existing.has(id)) mapped.unshift({ cap, dup: true });
        else {
          existing.add(id);
          mapped.unshift({ cap, dup: false });
        }

        return [ mapped, existing ];
      }, [ [], new Set() ]); // later duplicate capabilities have priority as it should act as if there was no duplicate

      if (capsObj[1].size > CONFIG.govee.rate_limit.max_stack) return res.status(400).json(format({ error: 'Too many capabilities for one call' }, 1));
      const caps = capsObj[0];

      if (sku in init.lookup) {
        const index = init.lookup[sku][macAddr]; if (index === undefined) return res.status(400).json(format({ error: 'Invalid device' }, 1));

        let apiCalls = 0;
        const rtn = [], promises = [];
        for (let i = 0; i < caps.length; i++) {
          const setReturn = (function(o) { rtn[this] = 0; }).bind(i);
          setReturn({ status: 0b000, message: 'pending' });
          
          const { dup, cap } = caps[i];
          if (dup) { setReturn({ status: 0b010, message: 'failure#duplicate', data: { error: 'Duplicated capablity requested' } }); continue; }

          const { type, instance, value } = cap ?? {}; if (type === undefined || instance === undefined) return res.status(400).json(format({ error: 'Invalid capability' }, 1));
          const hasCap = init.devices[index].capabilities.some(test => cap.type === test.type && cap.instance === test.instance);
          if (!hasCap) { setReturn({ status: 0b100, message: 'failure#missing_capability', data: { error: 'Device does not have requested capability' } }); continue; }
          else apiCalls++;

          console.log(`\n${new Date().toLocaleString()}: Setting %o for %o to %o\nSKU: %o\nMAC_ADDRESS: %o\n`, instance, type, value, sku, macAddr);

          const promise = fetch(CONFIG.govee.api + cap.path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Govee-API-Key': SECRET.govee.api_key },
            body: JSON.stringify({ requestId: 'uuid', payload: { sku, device: macAddr, capability: { type, instance, value } } }),
          })
            .then(r => r.json()).then(data => setReturn({ status: 0b001, message: 'success', data }))
            .catch(err => console.error(err) || setReturn({ status: 0b110, message: 'failure_fetch_error', data: err }));

          if (process === 'parallel') promises.push(promsie); // execute all fetch requests ASAP
          else await promise; // wait for fetch request to finish before proceeding to next fetch request 
        }

        if (process === 'parallel') await Promise.allSettled(promises); // wait for fetch requests to finish

        rateLimit.end = Date.now() + rateLimit.time * apiCalls;
        return res.status(200).json(format(rtn));
      } else return res.status(400).json(format({ error: 'Invalid SKU' }, 1));
    } break;
    default: {
      fetch(CONFIG.govee.api + path, {
        method: method,
        headers: { 'Content-Type': 'application/json', 'Govee-API-Key': SECRET.govee.api_key },
        body: method === 'POST' ? JSON.stringify(req.body) : undefined,
      })
        .then(response => response.json()).then(data => {
          rateLimit.end = Date.now() + rateLimit.time;
          return res.status(200).json(format(data));
        })
        .catch(error => {
          console.error(error);

          rateLimit.end = Date.now() + rateLimit.time;
          return res.status(500).json(format({ error: error.message }, 1));
        });
    } break;
  }
});

app.listen(CONFIG.server.port, () => console.log(`Proxy server running at http://localhost:${CONFIG.server.port}`));