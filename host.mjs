import fs from 'fs';

import fetch from 'node-fetch'; import express from 'express';
import cors from 'cors'; import bodyParser from 'body-parser';

const CONFIG = JSON.parse(fs.readFileSync('data/config.json', 'utf8'));
const DEFINE = JSON.parse(fs.readFileSync(CONFIG.pointer.define, 'utf8'));
const SECRET = JSON.parse(fs.readFileSync(CONFIG.pointer.secret, 'utf8'));

const precision = CONFIG.govee.rate_limit.precision;
const rateLimit = { end: -1, time: Math.round((86400000 / CONFIG.govee.rate_limit.quota + precision / 2) / precision) * precision };

const mem = {};

async function getDevices() {
  return await fetch(`${CONFIG.govee.api}/user/devices`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', 'Govee-API-Key': SECRET.govee.api_key },
  })
    .then(response => response.json()).then(data => data.data)
    .catch(error => ({ error: error.message }));
}

async function getData(sku, device, path) {
  return await fetch(`${CONFIG.govee.api}/device/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Govee-API-Key': SECRET.govee.api_key },
    body: JSON.stringify({ requestId: 'uuid', payload: { sku, device } }),
  })
    .then(response => response.json()).then(data => data.payload.capabilities)
    .catch(error => ({ error: error.message }));
}

let init = {};
async function INIT() {
  const devices = await getDevices(); if (devices.error) return console.error(devices.error) || false;
  init = { devices, states: [], lookup: {} };
  for (let i = 0; i < devices.length; i++) {
    const device = devices[i];
    const { sku, device: macAddress } = device ?? {}; if (sku === undefined || macAddress === undefined) return console.error('Invalid device') || false;

    if (init.lookup[sku] === undefined) init.lookup[sku] = { [macAddress]: i };
    else init.lookup[sku][macAddress] = i;

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
      const lightScene = await getData(sku, macAddress, 'scenes'); if (lightScene.error) return console.error(lightScene.error) || false;
      device.capabilities[find['devices.capabilities.dynamic_scene lightScene']] = lightScene[0];
    }

    if (find['devices.capabilities.dynamic_scene diyScene']) {
      const diyScene = await getData(sku, macAddress, 'diy-scenes'); if (diyScene.error) return console.error(diyScene.error) || false;
      device.capabilities[find['devices.capabilities.dynamic_scene diyScene']] = diyScene[0];
    }

    const state = await getData(sku, macAddress, 'state'); if (state.error) return console.error(state.error) || false;
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
      const { sku, device, capabilities } = body ?? {}; if (sku === undefined || device === undefined || !Array.isArray(capabilities)) return res.status(400).json(format({ error: 'Invalid body' }, 1));
      if (capabilities.length > CONFIG.govee.rate_limit.max_stack) return res.status(400).json(format({ error: 'Too many capabilities for one call' }, 1));

      if (sku in init.lookup) {
        const index = init.lookup[sku][device]; if (index === undefined) return res.status(400).json(format({ error: 'Invalid device' }, 1));

        let apiCalls = 0;
        const returnObj = [], promises = [];
        for (let i = 0; i < capabilities.length; i++) {
          const capability = capabilities[i];
          const { type, instance, value } = capability ?? {}; if (type === undefined || instance === undefined) return res.status(400).json(format({ error: 'Invalid capability' }, 1));

          const hasCapability = init.devices[index].capabilities.some(cap => cap.type === capability.type && cap.instance === capability.instance);
          if (!hasCapability) {
            returnObj[i] = { status: -1, message: 'failure', data: { error: 'Invalid capability' } };
            continue;
          } else apiCalls++;

          console.log(`\n${new Date().toLocaleString()}: Setting %s for %s to %o\nSKU: %s\nMAC_ADDRESS: %s\n`, instance, type, value, sku, device);

          returnObj[i] = { status: 0, message: 'pending' };
          const o = returnObj[i];
          const promise = fetch(CONFIG.govee.api + capability.path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Govee-API-Key': SECRET.govee.api_key },
            body: JSON.stringify({ requestId: 'uuid', payload: { sku, device, capability: { type, instance, value } } }),
          })
            .then(response => response.json()).then(data => { o.status = 1; o.message = 'success'; o.data = data })
            .catch(error => { o.status = -1; o.message = 'failure'; o.data = error });

          promises.push(promise);
        }

        rateLimit.end = Date.now() + rateLimit.time * apiCalls;
        return res.status(200).json(format(returnObj));
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