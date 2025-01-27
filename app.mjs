import { util_app, util, proto } from './src/js/utility.mjs';
proto.import('Number', 'Object');

import fs from 'fs';

import fetch from 'node-fetch'; import express from 'express';
import cors from 'cors'; import bodyParser from 'body-parser';

const clientData = {},
      constant  = util_app.readDataFile(fs, 'constant', 'data/constant.json', clientData),
      config = util_app.readDataFile(fs, 'config', constant.file.config, clientData),
      secret = util_app.readDataFile(fs, 'secret', constant.file.secret, clientData);

const rateLimit = { end: -1, time: 0 };
{
  const { quota, precision: pr } = config.api.rate_limit;
  rateLimit.time = Math.round((86400000 / quota + pr / 2) / pr) * pr;
}

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
    body: JSON.stringify({ requestId: util_app.createUuid(), payload: { sku, device } }),
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

    Object.safeSet(init.lookup, sku, macAddr, i);

    {
      const i = util.findCapabilityIndex(device, 'dynamic_scene', 'lightScene');
      if (i) {
        const scene = await getData(sku, macAddr, 'scenes'); if (scene.error) return console.error(scene.error) || false;
        device.capabilities[i] = scene[0];
      }
    }

    {
      const i = util.findCapabilityIndex(device, 'dynamic_scene', 'diyScene');
      if (i) {
        const scene = await getData(sku, macAddr, 'diy-scenes'); if (scene.error) return console.error(scene.error) || false;
        device.capabilities[i] = scene[0];
      }
    }

    const state = await getData(sku, macAddr, 'state'); if (state.error) return console.error(state.error) || false;
    init.states.push(state);
  }

  return true;
}
await INIT();

const getCountdown = () => Number.clamp(rateLimit.end - Date.now(), 0),
      formatResponse = (data, flat = false) => flat ? { ...data, countdown: getCountdown() } : { data, countdown: getCountdown() },
      aboveRateLimit = body => !(config.api.rate_limit.dev_mode && body.dev_mode) && getCountdown() > 0;

const app = express();
app.use(cors()); app.use(bodyParser.json());

app.set('view engine', 'ejs');
app.use(express.static('src'));

app.get('/', (req, res) => {
  res.render('index', { json: JSON.stringify(formatResponse(clientData)) });
});

app.use(util.getApiPath(config, 'govee'), async (req, res) => {
  const { method, path, body } = req; if (!config.api.govee.methods.includes(method)) return res.status(400).json(formatResponse({ error: 'Invalid method' }, 1));

  switch (path) { // non-rate limited calls
    case config.api.govee.devices.path: return res.status(200).json(formatResponse(init));
    default: { // rate limiter
      if (aboveRateLimit(body)) return res.status(429).json(formatResponse({ error: 'Rate limited' }, 1));
    } break;
  }

  switch (path) { // rate limited calls
    case config.api.govee.refresh_devices.path: {
      if (await INIT()) return res.status(200).json(formatResponse(init));
      return res.status(500).json(formatResponse({ error: 'Failed to re-initialize' }, 1));
    } break;
    case config.api.govee.controller.path: {
      const { sku, device: macAddr, capabilities } = body ?? {}; if (sku === undefined || macAddr === undefined || !Array.isArray(capabilities)) return res.status(400).json(formatResponse({ error: 'Invalid body' }, 1));
      const process = (body ?? {}).process ?? 'parallel'; if (process !== 'parallel' && process !== 'sequential') return res.status(400).json(formatResponse({ error: 'Invalid process' }, 1));

      const capsObj = capabilities.reverse().reduce(([ mapped, existing ], cap) => {
        const capId = JSON.stringify(cap);
        if (existing.has(capId)) mapped.unshift({ cap, dup: true });
        else {
          existing.add(capId);
          mapped.unshift({ cap, dup: false });
        }

        return [ mapped, existing ];
      }, [ [], new Set() ]); // later duplicate capabilities have priority as it should act as if there was no duplicate

      if (capsObj[1].size > config.api.rate_limit.max_controller_requests)
        return res.status(400).json(formatResponse({ error: 'Too many capabilities for one call' }, 1));

      const caps = capsObj[0];
      if (sku in init.lookup) {
        const index = init.lookup[sku][macAddr]; if (index === undefined) return res.status(400).json(formatResponse({ error: 'Invalid device' }, 1));
        const device = init.devices[index]; if (device === undefined) return res.status(400).json(formatResponse({ error: 'Invalid device' }, 1));

        let apiCalls = 0;
        const rtn = [], promises = [];
        for (let i = 0; i < caps.length; i++) {
          const setReturn = (function(o) { rtn[this] = o; }).bind(i);
          setReturn({ status: 0b000, message: 'pending' });

          const { dup, cap } = caps[i];
          if (dup) { setReturn({ status: 0b010, message: 'failure#duplicate', data: { error: 'Duplicated capability requested' } }); continue; }

          const { type, instance, value } = cap ?? {}; if (type === undefined || instance === undefined) return res.status(400).json(formatResponse({ error: 'Invalid capability' }, 1));
          const hasCap = util.findCapability(device, type, instance);
          if (!hasCap) { setReturn({ status: 0b100, message: 'failure#missing_capability', data: { error: 'Device does not have requested capability' } }); continue; }
          else apiCalls++;

          console.log(`\n${new Date().toLocaleString()}: Setting %o for %o to %o\nSKU: %o\nMAC_ADDRESS: %o\n`, instance, type, value, sku, macAddr);

          const promise = fetch(constant.api.govee.location + cap.path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Govee-API-Key': secret.govee.api_key },
            body: util_app.createGoveeBody(device, cap),
          })
            .then(r => r.json()).then(data => setReturn({ status: 0b001, message: 'success', data }))
            .catch(err => console.error(err) || setReturn({ status: 0b110, message: 'failure#fetch_error', data: err }));

          if (process === 'parallel') promises.push(promise); // execute all fetch requests ASAP
          else await promise; // wait for fetch request to finish before proceeding to next fetch request
        }

        if (process === 'parallel') await Promise.allSettled(promises); // wait for fetch requests to finish

        rateLimit.end = Date.now() + rateLimit.time * apiCalls;
        return res.status(200).json(formatResponse(rtn));
      } else return res.status(400).json(formatResponse({ error: 'Invalid SKU' }, 1));
    } break;
    default: return res.status(400).json(formatResponse({ error: 'Invalid path' }, 1));
  }
});

app.use(util.getApiPath(config, 'hcpss'), async (req, res) => {
  const { method, path, body } = req; if (!config.api.hcpss.methods.includes(method)) return res.status(400).json(formatResponse({ error: 'Invalid method' }, 1));

  switch (path) {
    case config.api.hcpss.calendar.path: {
      fetch(constant.api.hcpss.calendar.location)
        .then(r => r.text()).then(txt => res.status(200).send(txt))
        .catch(err => console.error(err) || res.status(500).json(formatResponse({ error: err.message }, 1)));
    } break;
    case config.api.hcpss.status.path: {
      fetch(constant.api.hcpss.status.location)
        .then(r => r.text()).then(txt => res.status(200).send(txt))
        .catch(err => console.error(err) || res.status(500).json(formatResponse({ error: err.message }, 1)));
    } break;
    default: return res.status(400).json(formatResponse({ error: 'Invalid path' }, 1));
  }
});

app.listen(config.server.port, () => console.log(`Proxy server running at http://localhost:${config.server.port}`));