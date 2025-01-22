import fs from 'fs';

import fetch from 'node-fetch';
import express from 'express';

import cors from 'cors';
import bodyParser from 'body-parser';

const secrets = { secure: JSON.parse(fs.readFileSync('secrets.json', 'utf8')) };

const API_BASE_URL = 'https://openapi.api.govee.com/router/api/v1/';
const API_KEY = secrets.secure.govee.apiKey;

delete secrets.secure;

const serverRateLimit = 60*60*24*1000 / 10000; // how many milliseconds to wait before making another request (backend rate limit)
const clientRateLimit = Math.ceil((60*60*24 / 10000 + 1) / 5) * 5000; // how many milliseconds to wait before making another request (client rate limit)
let rateLimiter = false;

const methods = ['GET', 'POST'];

let initData = { rateLimit: clientRateLimit };
async function getDevices() {
  return await fetch(`${API_BASE_URL}/user/devices`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Govee-API-Key': API_KEY,
    },
  })
    .then(response => response.json()).then(data => data.data)
    .catch(error => ({ error: error.message }));
}

async function getDynamicScene(sku, device) {
  return await fetch(`${API_BASE_URL}/device/scenes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Govee-API-Key': API_KEY,
    },
    body: JSON.stringify({
      'requestId': 'uuid',
      'payload': {
        'sku': sku,
        'device': device,
      },
    }),
  })
    .then(response => response.json()).then(data => data.payload.capabilities[0])
    .catch(error => ({ error: error.message }));
}

async function getDIYScene(sku, device) {
  return await fetch(`${API_BASE_URL}/device/diy-scenes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Govee-API-Key': API_KEY,
    },
    body: JSON.stringify({
      'requestId': 'uuid',
      'payload': {
        'sku': sku,
        'device': device,
      },
    }),
  })
    .then(response => response.json()).then(data => data.payload.capabilities[0])
    .catch(error => ({ error: error.message }));
}

async function init() {
  const devices = await getDevices(); if (devices.error) return false;

  initData = { rateLimit: clientRateLimit, devices, scenes: { dynamic: {}, DIY: {} } };
  for (const device of devices) {
    const sku = device.sku;
    const mac = device.device;

    const dynamicScene = await getDynamicScene(sku, mac); if (dynamicScene.error) return false;
    const DIYScene = await getDIYScene(sku, mac); if (DIYScene.error) return false;

    if (initData.scenes.dynamic[sku] === undefined) initData.scenes.dynamic[sku] = {};
    if (initData.scenes.DIY[sku] === undefined) initData.scenes.DIY[sku] = {};

    initData.scenes.dynamic[sku][mac] = dynamicScene;
    initData.scenes.DIY[sku][mac] = DIYScene;
  }

  return true;
}
await init();

const app = express();
app.use(cors()); app.use(bodyParser.json());

app.use('/proxy', async (req, res) => {
  const method = req.method;
  if (!methods.includes(method)) {
    res.status(400).json({ error: 'Invalid method' });
    return;
  }

  if (req.path === '/init')
    return res.status(200).json(initData);

  if (rateLimiter === false) {
    rateLimiter = Date.now();
    setTimeout(() => { rateLimiter = false; }, serverRateLimit);
  } else
    return res.status(429).json({ error: 'Rate limited', timeRemaining: serverRateLimit - Date.now() + rateLimiter });

  if (req.path === '/reinit') {
    if (await init()) res.status(200).json(initData);
    else res.status(500).json({ error: 'Failed to initialize' });
  }

  console.log(`${new Date().toLocaleString()}:\nProxying ${method} request to ${req.path}`, req.body);
  fetch(`${API_BASE_URL}${req.path}`, {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'Govee-API-Key': API_KEY,
    },
    body: method === 'POST' ? JSON.stringify(req.body) : undefined,
  })
    .then(response => response.json()).then(data => res.status(200).json(data))
    .catch(error => console.error(error) || res.status(500).json({ error: error.message }));
});

app.listen(3000, () => {
  console.log("Proxy server running at http://localhost:3000");
});