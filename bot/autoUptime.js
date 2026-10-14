'use strict';

const http = require('node:http');
const https = require('node:https');
const logger = require('../logger');

let timer = null;

function ping(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.get(target, { timeout: 10000 }, response => {
      response.resume();
      resolve(response.statusCode || 0);
    });
    request.on('timeout', () => request.destroy(new Error('uptime request timed out')));
    request.on('error', reject);
  });
}

function start() {
  stop();
  const cfg = global.config?.autoUptime;
  if (!cfg?.enabled || !cfg.url) return;

  const interval = Math.max(15, Number(cfg.intervalSeconds || 180)) * 1000;
  const run = async () => {
    try {
      const status = await ping(cfg.url);
      logger.debug('UPTIME', 'Heartbeat sent', { status });
    } catch (error) {
      logger.warn('UPTIME', 'Heartbeat failed', { error: String(error?.message || error) });
    }
  };
  timer = setInterval(run, interval);
  timer.unref();
  void run();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop };
