'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = function loadModels(directory) {
  return fs
    .readdirSync(directory)
    .filter(file => file.endsWith('.js'))
    .sort()
    .map(file => require(path.join(directory, file)));
};
